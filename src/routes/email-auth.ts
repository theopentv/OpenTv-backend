import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { mailConfigured, resetLink, sendResetEmail, sendVerificationEmail } from '@/mail';
import { requireAuth } from '@/middleware';
import {
  hashPassword,
  hashToken,
  needsRehash,
  newCode,
  newToken,
  sameToken,
  UNUSABLE_HASH,
  usablePassword,
  verifyPassword,
} from '@/passwords';
import {
  LOGIN_FAIL_LIMIT,
  LOGIN_LOCK_MS,
  MAX_CODE_TRIES,
  RESEND_COOLDOWN_MS,
  normaliseEmail,
  passwordError,
  placeholderHandle,
  RESET_TTL_MS,
  VERIFY_TTL_MS,
} from '@/pure';
import { overBudget, REGISTER_BUDGET } from '@/rate-limit';
import { revokeSessions, sign } from '@/session';

/**
 * Signing in with an email address, for people who will not use Apple or
 * Google.
 *
 * A STRANGER MUST NOT LEARN WHETHER AN ADDRESS HAS AN ACCOUNT — everywhere it
 * costs nothing. "Forgot password" always answers 202; a wrong password and an
 * unknown address give the same 401 after the same work. An endpoint that says
 * "no such user" is a membership oracle: point it at a mailing list and it
 * tells you which of those people use this app, which for a TV tracker is a
 * list of what they watch.
 *
 * REGISTRATION IS THE ONE EXCEPTION, and it is deliberate. It used to answer a
 * taken address exactly as a free one — "check your inbox" — and the cost fell
 * entirely on the honest majority: somebody whose address signs in with Google
 * pressed "Create account" and was sent to wait for a message that could not
 * help them. Now it names the providers already on the address, so the app can
 * say "use Google" and finish the job in one tap. What it concedes is that an
 * address has an account here — which the sign-in form would confirm to the
 * same person two taps later anyway.
 *
 * PASSWORDS NEVER APPEAR IN A URL, a log, or a response. See `passwords.ts`.
 */

export const emailAuth = new Hono<App>();

type CredRow = {
  profile_id: string;
  email: string;
  password_hash: string;
  verified_at: string | null;
  failed_count: number;
  locked_until: string | null;
  session_epoch: number;
};

/** The session a successful sign-in hands back — identical to every other provider's. */
async function session(env: Env, profileId: string, nowMs: number, verified: boolean, epoch = 0) {
  // AN UNVERIFIED ACCOUNT GETS A RESTRICTED TOKEN, not a full one. It can read
  // its own state, enter its code, ask for another, and delete itself; every
  // other route in the API refuses it. See `requireVerified`.
  const { token, expiresAt } = await sign(env, profileId, nowMs, verified ? 'full' : 'unverified', epoch);
  // `expires_at` in the envelope, matching every other sign-in response — the
  // app reads one shape whichever provider it used.
  return { token, expires_at: expiresAt, email_verified: verified };
}

function newProfileId(): string {
  return `p_${crypto.randomUUID().replace(/-/g, '')}`;
}

// ── POST /v1/auth/email/register ────────────────────────────────────────────

/**
 * Has this row had an email sent about it within the last minute?
 *
 * `updated_at` is stamped by every path that posts a message, so one clock
 * covers all of them: registering against a taken address, asking for another
 * confirmation, and requesting a reset cannot be combined to send three times
 * as much mail as any of them alone.
 *
 * CALLERS MUST NOT CHANGE THEIR ANSWER because of this. Two of the three are
 * written to look identical whether or not the address exists, and a 429 that
 * only appears for real accounts would undo that in a single request.
 */
function withinCooldown(updatedAt: string | null | undefined, nowMs: number): boolean {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) && nowMs - t < RESEND_COOLDOWN_MS;
}

emailAuth.post('/auth/email/register', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  /**
   * A HUNDRED ACCOUNTS IS A LOOP, NOT A PERSON.
   *
   * Nothing here needs a session, and each success writes a profile, an
   * identity and a credential row — then earns the right to upload a library's
   * worth of comments and ratings. Sign-in has had an IP budget since the
   * beginning; this endpoint, which is the one that creates things, had none.
   *
   * Counted BEFORE the address is even parsed, so a malformed body costs a slot
   * too — otherwise the cheapest way to probe is to send rubbish.
   */
  // CLOSED FOR NOW? See `EMAIL_SIGNUP` in env.ts. Checked before anything else
  // so a closed door costs no work and no rate-limit slot.
  if ((c.env.EMAIL_SIGNUP ?? 'on').toLowerCase() === 'off') {
    return fail(c, 503, 'unavailable', 'Email sign-up is temporarily unavailable. Use Apple or Google.');
  }

  const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';
  if (await overBudget(c.env, 'register', ip, REGISTER_BUDGET, Date.now())) {
    return fail(c, 429, 'rate_limited', 'Too many accounts from here. Try again later.');
  }

  const email = normaliseEmail(b.email);
  if (!email) return fail(c, 400, 'invalid_body', 'That does not look like an email address.');
  const bad = passwordError(b.password);
  if (bad) {
    const why =
      bad === 'too_short'
        ? 'Use at least 8 characters.'
        : bad === 'too_long'
          ? 'That password is too long.'
          : 'That password is too easy to guess.';
    return fail(c, 400, 'invalid_body', why);
  }
  const password = b.password as string;

  const db = c.env.DB;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  /**
   * EVERY WAY THIS ADDRESS MAY ALREADY BE IN USE, not just the email one.
   *
   * The old lookup read `email_credentials` alone, so an address that had only
   * ever signed in through Google or Apple looked free — and registering it
   * built a SECOND profile for the same person. Two accounts, one inbox, and
   * whichever they landed in was missing the other's comments and follows.
   * `identities` is the table that knows about all three providers, so the
   * check belongs there.
   *
   * `has_password` tests the SHAPE of the hash, not the presence of the row: a
   * provider account that has asked for its first password owns a row carrying
   * UNUSABLE_HASH, and answering `true` for it would send the app to offer
   * "Sign in instead" about a password nobody has ever set.
   */
  const claims = await db
    .prepare(
      `SELECT DISTINCT i.provider, (c.password_hash LIKE 'pbkdf2$%') AS has_password
         FROM identities i
         JOIN profiles p ON p.id = i.profile_id
         LEFT JOIN email_credentials c ON c.profile_id = i.profile_id
        WHERE LOWER(i.email) = ? AND p.deleted_at IS NULL`,
    )
    .bind(email)
    .all<{ provider: string; has_password: number }>();

  /**
   * AND THE CREDENTIAL ROW ITSELF, because an identity is not the only claim.
   *
   * They can come apart: an account created by email has both, but only the
   * identity is removed when a profile is deleted. Reading `identities` alone
   * would then miss a live account whose identity row was lost, and walk into
   * the UNIQUE constraint on `email_lower` — a 500 where a sentence belongs.
   */
  const credential = await db
    .prepare(
      `SELECT c.profile_id FROM email_credentials c JOIN profiles p ON p.id = c.profile_id
        WHERE c.email_lower = ? AND p.deleted_at IS NULL`,
    )
    .bind(email)
    .first<{ profile_id: string }>();

  const rows = claims.results ?? [];
  if (rows.length === 0 && credential) rows.push({ provider: 'email', has_password: 1 });

  if (rows.length > 0) {
    /**
     * IT SAYS SO, PLAINLY.
     *
     * This used to answer 202 "check your inbox" whether or not the address was
     * taken, so that nobody could use registration to discover who has an
     * account. The cost landed entirely on the honest majority: somebody whose
     * address signs in with Google pressed "Create account", was told to check
     * an inbox, and found either nothing they could act on or — worse — a
     * password reset for an account they did not know they had. A dead end
     * dressed as progress.
     *
     * So the trade is taken the other way, deliberately. The reply names the
     * providers already on the address, the app says "you signed in with
     * Google, use that", and one tap finishes what they came to do. What it
     * gives away is that an address has an OpenTV account — which the sign-in
     * form would confirm to the same person in two more taps anyway.
     */
    return c.json(
      {
        ok: false,
        account_exists: true,
        providers: [...new Set(rows.map((r) => r.provider))],
        has_password: rows.some((r) => r.has_password === 1),
      },
      200,
    );
  }

  /**
   * DELETING AN ACCOUNT NEVER FREED ITS ADDRESS.
   *
   * `DELETE /v1/me` removes the identity and marks the profile deleted, but the
   * `email_credentials` row outlives both — and `email_lower` is UNIQUE. So the
   * address belonged for ever to an account that no longer exists: registration
   * either answered "check your inbox" about nothing, or hit the constraint and
   * answered 500. Neither said the only true thing, which is that the account
   * is gone.
   *
   * Nothing above claims the address at this point, so any row still holding it
   * belongs to a dead profile and is debris. It goes now, and the registration
   * below proceeds — the address is genuinely free.
   */
  await db.prepare('DELETE FROM email_credentials WHERE email_lower = ?').bind(email).run();

  const profileId = newProfileId();
  const handle = placeholderHandle(profileId);
  const hash = await hashPassword(password);
  const token = newToken();
  const tokenHash = await hashToken(token);
  // The same expiry covers both: they are two ways to answer one question.
  // Decided before anything is written: it changes what the row means.
  const canMail = mailConfigured(c.env);
  const code = newCode();
  const codeHash = await hashToken(code);
  const expires = new Date(nowMs + VERIFY_TTL_MS).toISOString();

  await db.batch([
    db
      .prepare(// Private on creation, the same as the OAuth path -- see the note there.
      // An account is what a backup needs; being findable is a separate choice.
      'INSERT INTO profiles (id, handle, handle_lower, created_at, is_private) VALUES (?, ?, ?, ?, 1)')
      .bind(profileId, handle, handle.toLowerCase(), nowIso),
    // The identity row keeps every other part of the system — account deletion,
    // `resolveProfile`, "one profile, several sign-ins" — working without
    // knowing this table exists.
    db
      .prepare('INSERT INTO identities (provider, external_id, profile_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('email', email, profileId, email, nowIso),
    db
      .prepare(
        `INSERT INTO email_credentials
           (profile_id, email, email_lower, password_hash, verify_hash, verify_code_hash,
            verify_code_tries, verify_expires, created_at, updated_at, verified_at, auto_verified)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .bind(
        profileId,
        (b.email as string).trim(),
        email,
        hash,
        tokenHash,
        codeHash,
        expires,
        nowIso,
        nowIso,
        // CONFIRMED ON CREATION WHEN NOTHING CAN EVER CONFIRM IT. An instance
        // with no mail cannot deliver a code, and an unverified token is
        // refused by every route but the few that let you enter one — so
        // demanding it there is not a gate, it is a wall with nobody on the
        // other side of it.
        canMail ? null : nowIso,
        // ...and marked as never actually proved, so `linkTarget` refuses to
        // let a provider sign-in land in it. That is the takeover the
        // verification rule exists to stop, and it stays stopped.
        canMail ? 0 : 1,
      ),
  ]);

  /**
   * A SELF-HOSTED INSTANCE WITH NO MAIL IS A DEAD END WITHOUT THIS.
   *
   * Verification is not optional: an unverified token is refused by every route
   * but the handful in `UNVERIFIED_ALLOWED`, so an account that cannot confirm
   * cannot do anything, ever. On a box with no `MAIL_FROM` the message is never
   * sent, the code never arrives, and the app loops between "check your inbox"
   * and a community that refuses it — with nothing anywhere saying why.
   *
   * So when mail is not configured, the code goes to the operator's console
   * instead. They own the server and already read its logs; this tells them the
   * one thing they need to finish setting up an account, and it costs nothing
   * on the hosted Worker, where `MAIL_FROM` is always set and this never runs.
   */
  c.executionCtx.waitUntil(
    sendVerificationEmail(c.env, email, token, code).then((r) => {
      if (r.reason === 'not_configured') {
        console.log(`[opentv] no mail configured — verification code for ${email} is ${code}`);
      }
    }),
  );

  // SIGNED IN IMMEDIATELY, BUT ON A LEASH. The token carries `unverified`, so
  // the app has a session to draw its own state with and to confirm from — and
  // every other route in the API refuses it until the link is clicked.
  // Verified from the start when nothing could ever verify it — see the insert
  // above. A restricted token here would refuse every route on an instance that
  // has no way to lift the restriction.
  const s = await session(c.env, profileId, nowMs, !canMail);
  return c.json({ ...s, needs_handle: true }, 201);
});

/**
 * THE password check, for every door that takes an email and a password: the
 * app's sign-in below and the MCP consent page (`routes/mcp.ts`). One copy, so
 * the dummy-hash timing, the per-account lock and the rehash cannot drift
 * between them. Deleted profiles never match. Verification (`verified_at`) is
 * the caller's to judge: the app hands an unverified account a restricted
 * session, the consent page refuses it.
 */
export type PasswordCheck = { ok: true; row: CredRow } | { ok: false; why: 'no_password' | 'locked' | 'wrong' };

export async function checkEmailPassword(env: Env, email: string, password: string, nowMs: number): Promise<PasswordCheck> {
  const row = await env.DB.prepare(
    `SELECT c.profile_id, c.email, c.password_hash, c.verified_at, c.failed_count, c.locked_until,
            p.session_epoch
       FROM email_credentials c JOIN profiles p ON p.id = c.profile_id
      WHERE c.email_lower = ? AND p.deleted_at IS NULL`,
  )
    .bind(email)
    .first<CredRow>();

  // `usablePassword` as well as `row`: a provider account that asked for its
  // first password has a credential row carrying UNUSABLE_HASH, and telling
  // that person their password is wrong — about a password that does not exist
  // yet — is the sentence this branch was written to stop saying.
  if (!row || !usablePassword(row.password_hash)) {
    // NO EARLY RETURN WITHOUT WORK. Answering an unknown address instantly
    // while a known one takes 210,000 PBKDF2 rounds is a timing oracle that
    // enumerates users. Burn a comparable amount against a throwaway hash.
    //
    // Kept even though the answer below now distinguishes the two cases: the
    // timing must not become a SECOND channel that works when this route is
    // called with a garbage body, or from a client that ignores the code.
    await verifyPassword(password, DUMMY_HASH);
    return { ok: false, why: 'no_password' };
  }

  if (row.locked_until && Date.parse(row.locked_until) > nowMs) return { ok: false, why: 'locked' };

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    const failed = row.failed_count + 1;
    const lock = failed >= LOGIN_FAIL_LIMIT ? new Date(nowMs + LOGIN_LOCK_MS).toISOString() : null;
    await env.DB.prepare(
      'UPDATE email_credentials SET failed_count = ?, locked_until = ?, updated_at = ? WHERE profile_id = ?',
    )
      .bind(lock ? 0 : failed, lock, new Date(nowMs).toISOString(), row.profile_id)
      .run();
    return { ok: false, why: 'wrong' };
  }

  // A correct password clears the counter, and takes the chance to raise the
  // cost if the stored hash predates a bump — the only moment the plaintext is
  // available to re-hash with.
  const rehash = needsRehash(row.password_hash) ? await hashPassword(password) : null;
  await env.DB.prepare(
    `UPDATE email_credentials
        SET failed_count = 0, locked_until = NULL, password_hash = COALESCE(?, password_hash), updated_at = ?
      WHERE profile_id = ?`,
  )
    .bind(rehash, new Date(nowMs).toISOString(), row.profile_id)
    .run();

  return { ok: true, row };
}

// ── POST /v1/auth/email/login ───────────────────────────────────────────────

emailAuth.post('/auth/email/login', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const email = normaliseEmail(b.email);
  const password = typeof b.password === 'string' ? b.password : '';

  const wrong = () => fail(c, 401, 'unauthenticated', 'That email or password is wrong.');
  if (!email || password.length === 0) return wrong();

  const nowMs = Date.now();
  const check = await checkEmailPassword(c.env, email, password, nowMs);
  if (!check.ok && check.why === 'no_password') {
    /**
     * NO PASSWORD HERE — but is there an account at all?
     *
     * "That email or password is wrong" is true and useless in the two cases
     * that actually happen. Somebody who has never registered is told their
     * password is wrong, and somebody whose account is a Google one is told the
     * same about a password that has never existed. Both then try again.
     *
     * Registration already names the providers on an address, so saying it here
     * concedes nothing that is not two taps away on the previous screen — and
     * this is the screen where knowing it saves the person from guessing.
     */
    const claims = await c.env.DB.prepare(
      `SELECT DISTINCT i.provider FROM identities i JOIN profiles p ON p.id = i.profile_id
        WHERE LOWER(i.email) = ? AND p.deleted_at IS NULL`,
    )
      .bind(email)
      .all<{ provider: string }>();

    const providers = (claims.results ?? []).map((r) => r.provider).filter((p) => p !== 'email');
    if (providers.length > 0) {
      return c.json(
        { error: { code: 'use_provider', message: 'That address signs in another way.' }, providers },
        409,
      );
    }
    if ((claims.results ?? []).length === 0) {
      return fail(c, 404, 'no_account', 'There is no account with that address yet.');
    }
    return wrong();
  }
  if (!check.ok && check.why === 'locked') {
    // Deliberately its own code: this one IS safe to be specific about, because
    // reaching it already required knowing the address.
    return fail(c, 429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
  }
  if (!check.ok) return wrong();
  const row = check.row;

  // Signing in again does NOT lift the restriction — only confirming does.
  // The account's CURRENT epoch, not zero: a reset raises it, and a token
  // issued without it would be older than the revocation and refused on its
  // first use — the new password would appear not to work.
  const s = await session(c.env, row.profile_id, nowMs, row.verified_at != null, row.session_epoch ?? 0);
  return c.json(s);
});

/** A real hash of a value nobody knows, so the unknown-address path costs what
 *  the known one costs. Generated once at module load. */
const DUMMY_HASH =
  'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// ── POST /v1/auth/email/verify ──────────────────────────────────────────────

/**
 * Confirm an address, by LINK or by CODE.
 *
 * WHY TWO. The link is a deep link into the app, so it only works on the device
 * that opened the email. Read the message on a phone while signing in on a
 * tablet, a simulator, or a second handset and there is nothing to tap — no app
 * on that machine claims the scheme. The code crosses the room.
 *
 * THE CODE IS NOT A SHORT TOKEN. A token is looked up BY its hash, so a
 * six-digit value used the same way would be a search across every account at
 * once. The code is accepted only together with the address it was sent to, and
 * only `MAX_CODE_TRIES` times, after which it is dead until another is asked
 * for — one row, a handful of guesses, rather than a million against the table.
 */
emailAuth.post('/auth/email/verify', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const token = typeof b.token === 'string' ? b.token : '';
  const email = normaliseEmail(b.email);
  // Spaces and dashes because people paste what they see, and a code shown as
  // `042 317` is the same code.
  const code = typeof b.code === 'string' ? b.code.replace(/[\s-]/g, '') : '';

  const nowIso = new Date().toISOString();
  type Row = {
    profile_id: string;
    verify_hash: string | null;
    verify_code_hash: string | null;
    verify_code_tries: number;
    verify_expires: string | null;
  };
  const COLS = 'profile_id, verify_hash, verify_code_hash, verify_code_tries, verify_expires';
  // Deliberately one message for every failure below. "No such code", "wrong
  // code", "expired" and "out of guesses" are four facts a guesser would like.
  const dead = () => fail(c, 400, 'invalid_body', 'That link or code is not valid any more. Ask for a new one.');

  let row: Row | null = null;

  if (token) {
    const hash = await hashToken(token);
    row = await c.env.DB.prepare(`SELECT ${COLS} FROM email_credentials WHERE verify_hash = ?`)
      .bind(hash)
      .first<Row>();
    if (!row || !row.verify_hash || !sameToken(row.verify_hash, hash)) return dead();
  } else if (email && /^[0-9]{6}$/.test(code)) {
    row = await c.env.DB.prepare(`SELECT ${COLS} FROM email_credentials WHERE email_lower = ?`)
      .bind(email)
      .first<Row>();
    if (!row || !row.verify_code_hash) return dead();
    if (row.verify_code_tries >= MAX_CODE_TRIES) return dead();

    const hash = await hashToken(code);
    if (!sameToken(row.verify_code_hash, hash)) {
      // SPENT WHETHER OR NOT IT WAS CLOSE. Counting only correct-shaped guesses
      // would be a counter that never moves.
      await c.env.DB.prepare(
        'UPDATE email_credentials SET verify_code_tries = verify_code_tries + 1, updated_at = ? WHERE profile_id = ?',
      )
        .bind(nowIso, row.profile_id)
        .run();
      return dead();
    }
  } else {
    return fail(c, 400, 'invalid_body', 'A token, or an email address and a six-digit code, is required.');
  }

  if (!row.verify_expires || row.verify_expires < nowIso) return dead();

  await c.env.DB.prepare(
    `UPDATE email_credentials
        SET verified_at = ?, verify_hash = NULL, verify_code_hash = NULL,
            verify_code_tries = 0, verify_expires = NULL, updated_at = ?
      WHERE profile_id = ?`,
  )
    .bind(nowIso, nowIso, row.profile_id)
    .run();

  // A FULL TOKEN COMES BACK WITH IT. The restriction lives in the token, so
  // confirming has to hand over a new one — otherwise the app would be verified
  // in the database and still locked out until the old session expired.
  //
  // Returned even though this route is unauthenticated: whoever holds the link
  // has proved they can read that inbox, which is a stronger claim than the
  // session they may or may not still have on the device they are reading on.
  const epoch =
    (
      await c.env.DB.prepare('SELECT session_epoch FROM profiles WHERE id = ?')
        .bind(row.profile_id)
        .first<{ session_epoch: number }>()
    )?.session_epoch ?? 0;
  const s = await session(c.env, row.profile_id, Date.parse(nowIso), true, epoch);
  return c.json({ ok: true, ...s });
});

// ── POST /v1/me/email/resend ────────────────────────────────────────────────

emailAuth.post('/me/email/resend', requireAuth, async (c) => {
  const me = c.get('profileId');
  const nowMs = Date.now();
  const row = await c.env.DB.prepare(
    'SELECT email, verified_at, updated_at FROM email_credentials WHERE profile_id = ?',
  )
    .bind(me)
    .first<{ email: string; verified_at: string | null; updated_at: string }>();
  if (!row) return fail(c, 404, 'not_found', 'This account does not sign in with an email address.');
  if (row.verified_at) return c.json({ ok: true, email_verified: true });

  // A COOLDOWN, because "send it again" is a button people press. Without one
  // it is a way to make this server post mail at an address repeatedly, and the
  // address is not necessarily one the presser owns.
  // AUTHENTICATED, so a 429 here reveals nothing — the caller already holds a
  // session for this account. It is the one place the honest answer is safe.
  if (withinCooldown(row.updated_at, nowMs)) {
    return fail(c, 429, 'rate_limited', 'Wait a minute before asking for another email.');
  }

  const token = newToken();
  const code = newCode();
  await c.env.DB.prepare(
    `UPDATE email_credentials
        SET verify_hash = ?, verify_code_hash = ?, verify_code_tries = 0,
            verify_expires = ?, updated_at = ?
      WHERE profile_id = ?`,
  )
    .bind(
      await hashToken(token),
      await hashToken(code),
      new Date(nowMs + VERIFY_TTL_MS).toISOString(),
      new Date(nowMs).toISOString(),
      me,
    )
    .run();
  c.executionCtx.waitUntil(sendVerificationEmail(c.env, row.email, token, code).then(() => undefined));
  return c.json({ ok: true, email_verified: false });
});

// ── POST /v1/me/password ────────────────────────────────────────────────────

/**
 * Add a password to an account that signs in with Apple or Google.
 *
 * THE POINT: two doors into one account. Somebody who joined with Google can
 * set a password and afterwards use either — and, more importantly, is not
 * locked out on a device where the provider sign-in fails, or if they ever
 * stop using that Google account.
 *
 * NO CONFIRMATION EMAIL, and that is not an oversight. The address comes from
 * the identity the provider issued, not from anything typed here, and the
 * provider has already verified it — which is exactly the standard the LINKING
 * rule holds out for. Sending a "confirm your address" mail for an address
 * Google just vouched for would be theatre. So the row is written already
 * confirmed, and that is also what makes the reverse direction work: sign in
 * with Google, set a password, and a later email sign-in finds a confirmed
 * account rather than a second one.
 *
 * NOT A PASSWORD CHANGE. If this account already has one, changing it is the
 * reset flow, which proves possession of the inbox first. This route only ever
 * fills an empty slot.
 */
emailAuth.post('/me/password', requireAuth, async (c) => {
  const me = c.get('profileId');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const bad = passwordError((body as Record<string, unknown>)?.password);
  if (bad) {
    return fail(
      c,
      400,
      'invalid_body',
      bad === 'too_short' ? 'Use at least 8 characters.' : bad === 'too_long' ? 'That password is too long.' : 'That password is too easy to guess.',
    );
  }
  // `passwordError` already proved it is a usable string; this satisfies the
  // compiler without a cast that would outlive the check.
  const raw = (body as Record<string, unknown>).password;
  const password = typeof raw === 'string' ? raw : '';

  const existing = await c.env.DB.prepare('SELECT profile_id FROM email_credentials WHERE profile_id = ?')
    .bind(me)
    .first<{ profile_id: string }>();
  if (existing) return fail(c, 403, 'forbidden', 'This account already has a password.');

  // The address the PROVIDER gave us, never one supplied in the request — that
  // would let anybody claim any address by typing it.
  const identity = await c.env.DB.prepare(
    "SELECT email FROM identities WHERE profile_id = ? AND provider IN ('apple','google') AND email IS NOT NULL LIMIT 1",
  )
    .bind(me)
    .first<{ email: string }>();
  if (!identity?.email) {
    return fail(c, 400, 'invalid_body', 'This account has no email address to attach a password to.');
  }

  const nowIso = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO email_credentials
         (profile_id, email, email_lower, password_hash, verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(me, identity.email, normaliseEmail(identity.email) ?? identity.email.trim().toLowerCase(), await hashPassword(password), nowIso, nowIso, nowIso)
      .run();
  } catch {
    // `email_lower` is UNIQUE: somebody else already registered this address
    // with a password. Refusing is right — the two accounts are not provably
    // the same person, and merging them here would be a takeover in the other
    // direction.
    return fail(c, 409, 'handle_taken', 'That address already has a password on another account.');
  }

  return c.json({ ok: true, email: identity.email });
});

// ── POST /v1/auth/email/forgot ──────────────────────────────────────────────

emailAuth.post('/auth/email/forgot', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const email = normaliseEmail((body as Record<string, unknown>)?.email);

  // ALWAYS 202, whether or not the address is here. This is the endpoint most
  // obviously shaped like a membership oracle, and the only defence is that its
  // answer carries no information.
  if (email) {
    const nowMs = Date.now();
    const nowStamp = new Date(nowMs).toISOString();
    let row = await c.env.DB.prepare(
      `SELECT c.profile_id, c.email, c.updated_at FROM email_credentials c JOIN profiles p ON p.id = c.profile_id
        WHERE c.email_lower = ? AND p.deleted_at IS NULL`,
    )
      .bind(email)
      .first<{ profile_id: string; email: string; updated_at: string }>();

    /**
     * A GOOGLE OR APPLE ACCOUNT HAS NO CREDENTIAL ROW TO UPDATE.
     *
     * This is how somebody with a provider account gets their FIRST password —
     * the app offers "Set a password" precisely because that account has none,
     * and without this the button was a dead end: no row, no token, no email,
     * silence for ever. `POST /v1/me/password` is the only other way and it
     * needs a session, which is exactly what the person cannot get.
     *
     * The row is created with an UNUSABLE password hash. It cannot be signed in
     * with — `verifyPassword` fails closed on a hash it cannot parse — so this
     * opens no door by itself; the reset that follows is what sets a real one.
     *
     * `verified_at` is stamped because the address is already proven twice
     * over: the provider vouched for it, and the reset link about to be sent
     * can only be used by whoever reads that inbox.
     */
    if (!row) {
      const identity = await c.env.DB.prepare(
        `SELECT i.profile_id, i.email FROM identities i JOIN profiles p ON p.id = i.profile_id
          WHERE LOWER(i.email) = ? AND p.deleted_at IS NULL
          LIMIT 1`,
      )
        .bind(email)
        .first<{ profile_id: string; email: string }>();
      if (identity) {
        // Debris first. A credential row left by an account deleted before the
        // fix still holds `email_lower`, which is UNIQUE — the insert below
        // would fail on it and this branch would go silent again.
        await c.env.DB.prepare(
          `DELETE FROM email_credentials WHERE email_lower = ? AND profile_id NOT IN
             (SELECT id FROM profiles WHERE deleted_at IS NULL)`,
        )
          .bind(email)
          .run();
        await c.env.DB.prepare(
          `INSERT INTO email_credentials
             (profile_id, email, email_lower, password_hash, verified_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id) DO NOTHING`,
        )
          .bind(identity.profile_id, identity.email, email, UNUSABLE_HASH, nowStamp, nowStamp, nowStamp)
          .run();
        row = { profile_id: identity.profile_id, email: identity.email, updated_at: '' };
      }
    }
    // The cooldown is silent here for the same reason the 202 is: a 429 that
    // only real addresses could produce would answer the question this whole
    // endpoint refuses to answer.
    if (row && !withinCooldown(row.updated_at, nowMs)) {
      const token = newToken();
      await c.env.DB.prepare(
        'UPDATE email_credentials SET reset_hash = ?, reset_expires = ?, updated_at = ? WHERE profile_id = ?',
      )
        .bind(await hashToken(token), new Date(nowMs + RESET_TTL_MS).toISOString(), new Date(nowMs).toISOString(), row.profile_id)
        .run();
      /**
       * SAME REASON AS THE VERIFICATION CODE ABOVE: with no mail configured the
       * message never leaves, and "Set a password" — which is how a provider-
       * only account gets its first one — silently goes nowhere. The reset
       * carries a LINK and no code, so the link is what the operator needs.
       */
      c.executionCtx.waitUntil(
        sendResetEmail(c.env, row.email, token).then((r) => {
          if (r.reason === 'not_configured') {
            console.log(`[opentv] no mail configured — password reset link for ${row.email}: ${resetLink(c.env, token)}`);
          }
        }),
      );
    }
  }
  return c.json({ ok: true }, 202);
});

// ── POST /v1/auth/email/reset ───────────────────────────────────────────────

emailAuth.post('/auth/email/reset', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const token = b.token;
  if (typeof token !== 'string' || token.length === 0) return fail(c, 400, 'invalid_body', 'A token is required.');
  const bad = passwordError(b.password);
  if (bad) return fail(c, 400, 'invalid_body', bad === 'too_common' ? 'That password is too easy to guess.' : 'Use at least 8 characters.');

  const hash = await hashToken(token);
  const nowIso = new Date().toISOString();
  const row = await c.env.DB.prepare(
    'SELECT profile_id, reset_hash, reset_expires FROM email_credentials WHERE reset_hash = ?',
  )
    .bind(hash)
    .first<{ profile_id: string; reset_hash: string; reset_expires: string | null }>();
  if (!row || !sameToken(row.reset_hash, hash) || !row.reset_expires || row.reset_expires < nowIso) {
    return fail(c, 400, 'invalid_body', 'That link has expired. Ask for a new one.');
  }

  // A completed reset also VERIFIES the address: they proved they can read mail
  // sent to it, which is the only thing verification ever established. And it
  // clears the lockout — the person who owns the inbox is not the attacker it
  // was defending against.
  await c.env.DB.prepare(
    `UPDATE email_credentials
        SET password_hash = ?, reset_hash = NULL, reset_expires = NULL,
            verified_at = COALESCE(verified_at, ?), failed_count = 0, locked_until = NULL, updated_at = ?
      WHERE profile_id = ?`,
  )
    .bind(await hashPassword(b.password as string), nowIso, nowIso, row.profile_id)
    .run();

  // AND EVERY EXISTING SESSION DIES.
  //
  // Without this the reset changed a password and nothing else: whoever was
  // already signed in — which, if the password leaked, is the person you are
  // resetting because of — kept the account for the remaining life of their
  // token, up to seven days. "I changed my password" has to mean "and they are
  // out", or it means very little.
  const epoch = Math.floor(Date.parse(nowIso) / 1000);
  await c.env.DB.prepare('UPDATE profiles SET session_epoch = ? WHERE id = ?').bind(epoch, row.profile_id).run();
  await revokeSessions(c.env, row.profile_id, epoch);

  return c.json({ ok: true });
});

// ── POST /v1/me/sessions/revoke ─────────────────────────────────────────────

/**
 * "Sign out my other devices."
 *
 * The honest answer to "somebody else is using my account": the password alone
 * cannot help, because they are already holding a session. This ends every one
 * of them — including this caller's — and the app signs in again with the new
 * token returned here, so the person who asked is the only one left.
 */
emailAuth.post('/me/sessions/revoke', requireAuth, async (c) => {
  const me = c.get('profileId');
  const nowMs = Date.now();
  const epoch = Math.floor(nowMs / 1000);

  const res = await c.env.DB.prepare(
    'UPDATE profiles SET session_epoch = ? WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(epoch, me)
    .run();
  if (res.meta.changes === 0) return fail(c, 401, 'unauthenticated', 'No such profile.');
  await revokeSessions(c.env, me, epoch);

  // Issued AFTER the revocation, so it carries the new epoch and survives it.
  const { token, expiresAt } = await sign(c.env, me, nowMs, 'full', epoch);
  return c.json({ ok: true, token, expires_at: expiresAt });
});
