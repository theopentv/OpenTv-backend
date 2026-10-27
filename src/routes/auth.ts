import { Hono } from 'hono';
import { verifyIdToken } from '@/auth';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import {
  COVER_HOSTS,
  HIDEABLE_SECTIONS,
  isHandleValid,
  needsHandle,
  normaliseHandle,
  parseHiddenSections,
  placeholderHandle,
  plusOn,
  validateHiddenSections,
  validCoverUrl,
  type Provider,
  validateCoverFrame,
} from '@/pure';
import { overBudget, SESSION_BUDGET } from '@/rate-limit';
import { RENEW_AFTER_SECONDS, sign } from '@/session';
import { refreshCommsuniProfile } from '@/routes/commsuni';
import { freeMonthOpen } from '@/routes/free-month';

/**
 * Sign-in, the session, the handle flow, and account deletion.
 * docs/IMPLEMENTATION.md §1d, endpoint for endpoint.
 */

export const auth = new Hono<App>();

// ── shapes ───────────────────────────────────────────────────────────────────

type ProfileRow = {
  id: string;
  handle: string;
  handle_lower: string;
  display_name: string | null;
  avatar_key: string | null;
  cover_url: string | null;
  theme_color: string | null;
  theme_layout: string | null;
  cover_frame: string | null;
  widgets: string | null;
  bio: string | null;
  is_private: number;
  tvtime_user_id: number | null;
  tvtime_handle: string | null;
  links: string | null;
  plus_until: string | null;
  is_plus: number;
  hidden_sections: string | null;
  created_at: string;
  deleted_at: string | null;
  free_month_at?: string | null;
  free_month_via?: string | null;
};

function parseLinks(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The own-profile view. `handle_lower` and `deleted_at` are internal. */
function ownProfile(row: ProfileRow) {
  return {
    id: row.id,
    handle: row.handle,
    display_name: row.display_name,
    avatar_key: row.avatar_key,
    cover_url: row.cover_url,
    theme_color: row.theme_color,
    theme_layout: row.theme_layout,
    cover_frame: row.cover_frame ?? null,
    widgets: row.widgets,
    bio: row.bio,
    is_private: row.is_private,
    tvtime_user_id: row.tvtime_user_id,
    tvtime_handle: row.tvtime_handle,
    links: parseLinks(row.links),
    plus_until: row.plus_until,
    // The same boolean everybody else's profile carries, so the app has one
    // field to read whether it is drawing itself or a stranger. The owner also
    // gets the raw date above — it is their own billing, not a stranger's.
    is_plus: plusOn(row, new Date().toISOString()),
    // ALWAYS, and as an array. This is the settings screen's own state: a
    // switch it cannot read is a switch that draws itself off after every sign
    // in, and the user turns it on a second time believing it never worked.
    hidden_sections: parseHiddenSections(row.hidden_sections),
    created_at: row.created_at,
  };
}

/** `p_` + a UUID with the hyphens stripped. Never the provider `sub` — that is the whole reason `identities` is a separate table. */
function newProfileId(): string {
  return `p_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * The profile a provider sign-in should JOIN rather than duplicate, or null.
 *
 * Only a CONFIRMED email account on a live profile qualifies. Everything else
 * — no such address, an unconfirmed registration, a deleted profile — answers
 * null, and the caller makes a fresh account instead.
 *
 * Exported for its tests. This is the whole of the rule that decides whether
 * one person's sign-in can land in another person's account, so it is pinned
 * directly rather than through a route that needs a signed provider token.
 *
 * `auto_verified = 0` IS PART OF THE CONDITION. An instance with no mail marks
 * its accounts confirmed so people can finish signing up at all — nothing there
 * can deliver a code — but nothing PROVED the address, so such an account must
 * never be the thing a provider sign-in lands in. That is the takeover this
 * function exists to refuse.
 */
export async function linkTarget(db: D1Database, email: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT c.profile_id FROM email_credentials c
         JOIN profiles p ON p.id = c.profile_id
        WHERE c.email_lower = ? AND c.verified_at IS NOT NULL AND c.auto_verified = 0
              AND p.deleted_at IS NULL`,
    )
    .bind(email.trim().toLowerCase())
    .first<{ profile_id: string }>();
  return row?.profile_id ?? null;
}

/**
 * The profile behind an identity — found, or created together with it.
 *
 * Shared by the real sign-in and the development one below, so the two cannot
 * drift: a test account built even slightly differently from a real one would
 * be testing something the app never does.
 */
async function resolveProfile(
  db: D1Database,
  provider: string,
  subject: string,
  email: string | null,
  nowIso: string,
  /**
   * Whether the PROVIDER says it has verified this address. Only then may it
   * be used to find an existing account — see `linkTarget`. Defaults false so
   * every caller that does not pass it (the tests, and any future one) links
   * nothing.
   */
  emailVerified = false,
): Promise<ProfileRow | null> {
  const lookup = db
    .prepare(
      `SELECT p.* FROM identities i JOIN profiles p ON p.id = i.profile_id
       WHERE i.provider = ? AND i.external_id = ?`,
    )
    .bind(provider, subject);

  // 1. The lookup runs first, alone: a batch() cannot branch on a result.
  let row = await lookup.first<ProfileRow>();

  if (row && row.deleted_at) {
    // Defensive only — DELETE /v1/me removes the identity row, so a deleted
    // profile should never still be reachable through one. Treat it as absent
    // and re-point the identity at a fresh profile.
    const id = newProfileId();
    await db.batch([
      db
        .prepare(/*
           * PRIVATE ON CREATION, and set here rather than as a column default.
           *
           * `is_private` has defaulted to 0 since the first migration, from a
           * time when the only way to get a profile was to ask for one on the
           * community screen. That stopped being true: an account is what
           * cloud backup and device sync need, and somebody who signs in only
           * so their library has somewhere to go has not asked to be browsable.
           *
           * NOT a schema change. Rewriting the table to alter a default would
           * mean recreating it, and `profiles` has gained ten columns since
           * 0001 -- is_plus, plus_since, cover_url, session_epoch,
           * hidden_sections, theme_color, theme_layout, widgets, last_seen_at,
           * app_version. A rewrite that forgot one would quietly delete every
           * subscriber's Plus flag. Existing rows are untouched for the same
           * reason they should be: everyone who has a profile today chose to
           * be visible on a screen that said so.
           */
          'INSERT INTO profiles (id, handle, handle_lower, created_at, is_private) VALUES (?, ?, ?, ?, 1)')
        .bind(id, placeholderHandle(id), placeholderHandle(id), nowIso),
      db
        .prepare(
          'UPDATE identities SET profile_id = ?, email = ?, created_at = ? WHERE provider = ? AND external_id = ?',
        )
        .bind(id, email, nowIso, provider, subject),
    ]);
    return db.prepare('SELECT * FROM profiles WHERE id = ?').bind(id).first<ProfileRow>();
  }

  if (!row) {
    // 1b. NO IDENTITY YET — but perhaps an account already, made with this
    // address and a password. Signing in with Google after registering by
    // email is the same person doing the same thing through a different door,
    // and giving them a second empty profile is the wrong answer.
    //
    // BOTH SIDES MUST HAVE PROVED THE ADDRESS. The provider vouches for it
    // (`emailVerified`), and the local account confirmed it (`verified_at`).
    // Linking to an UNCONFIRMED local account would be the classic takeover:
    // register victim@example.com with a password you know, wait for them to
    // sign in with Google, and you are inside their account. An unconfirmed
    // registration reserves nothing.
    const linked = emailVerified && email ? await linkTarget(db, email) : null;
    if (linked) {
      await db
        .prepare(
          'INSERT INTO identities (provider, external_id, profile_id, email, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(provider, subject, linked, email, nowIso)
        .run();
      return db.prepare('SELECT * FROM profiles WHERE id = ?').bind(linked).first<ProfileRow>();
    }

    // 2. Not found → one batch, so a crash cannot orphan an identity.
    const id = newProfileId();
    const handle = placeholderHandle(id);
    try {
      await db.batch([
        db
          .prepare(/*
           * PRIVATE ON CREATION, and set here rather than as a column default.
           *
           * `is_private` has defaulted to 0 since the first migration, from a
           * time when the only way to get a profile was to ask for one on the
           * community screen. That stopped being true: an account is what
           * cloud backup and device sync need, and somebody who signs in only
           * so their library has somewhere to go has not asked to be browsable.
           *
           * NOT a schema change. Rewriting the table to alter a default would
           * mean recreating it, and `profiles` has gained ten columns since
           * 0001 -- is_plus, plus_since, cover_url, session_epoch,
           * hidden_sections, theme_color, theme_layout, widgets, last_seen_at,
           * app_version. A rewrite that forgot one would quietly delete every
           * subscriber's Plus flag. Existing rows are untouched for the same
           * reason they should be: everyone who has a profile today chose to
           * be visible on a screen that said so.
           */
          'INSERT INTO profiles (id, handle, handle_lower, created_at, is_private) VALUES (?, ?, ?, ?, 1)')
          .bind(id, handle, handle, nowIso),
        db
          .prepare(
            'INSERT INTO identities (provider, external_id, profile_id, email, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(provider, subject, id, email, nowIso),
      ]);
      row = await db.prepare('SELECT * FROM profiles WHERE id = ?').bind(id).first<ProfileRow>();
    } catch {
      // The race — two devices, first sign-in, same instant — resolves at the
      // identities primary key. The loser re-runs the lookup and returns the
      // winner's profile.
      row = await lookup.first<ProfileRow>();
    }
  }
  return row;
}

// ── POST /v1/auth/session ────────────────────────────────────────────────────

auth.post('/auth/session', async (c) => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';
  if (await overBudget(c.env, 'session', ip, SESSION_BUDGET, now)) {
    return fail(c, 429, 'rate_limited', 'Too many sign-in attempts. Try again later.');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const provider = b.provider;
  if (provider !== 'apple' && provider !== 'google') {
    return fail(c, 400, 'invalid_body', 'provider must be "apple" or "google".');
  }
  if (typeof b.id_token !== 'string' || b.id_token.length === 0) {
    return fail(c, 400, 'invalid_body', 'id_token is required.');
  }
  // `tvtime_user_id` may appear in the body and is IGNORED here. It is written
  // write-once by POST /v1/me/friends/reconcile (Step 4) and nowhere else.

  const verified = await verifyIdToken(c.env, provider as Provider, b.id_token, now);
  if (!verified.ok) return fail(c, 401, 'unauthenticated', 'ID token rejected.');

  const row = await resolveProfile(
    c.env.DB,
    provider,
    verified.token.sub,
    verified.token.email ?? null,
    nowIso,
    verified.token.emailVerified,
  );
  if (!row) return fail(c, 500, 'internal', 'Could not establish a profile.');

  const { token, expiresAt } = await sign(c.env, row.id, now);
  return c.json({
    token,
    expires_at: expiresAt,
    profile: ownProfile(row),
    needs_handle: needsHandle(row.handle),
  });
});

// ── everything below needs a session ─────────────────────────────────────────

auth.use('/me', requireAuth);
auth.use('/me/*', requireAuth);

// ── POST /v1/me/join ─────────────────────────────────────────────────────────

/**
 * The phone joined the community (1.6.7 calls this from `joinCommunity`).
 * Joining used to be a flag on the phone alone, so the server could not tell a
 * member from an account made for backup (0049). Idempotent.
 */
auth.post('/me/join', async (c) => {
  await c.env.DB.prepare('UPDATE profiles SET joined_at = ? WHERE id = ? AND joined_at IS NULL AND deleted_at IS NULL')
    .bind(new Date().toISOString(), c.get('profileId'))
    .run();
  return c.json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
});

// ── GET /v1/me ───────────────────────────────────────────────────────────────

auth.get('/me', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM notifications WHERE recipient_id = p.id AND read_at IS NULL) AS unread,
            c.email        AS cred_email,
            c.verified_at  AS cred_verified_at
       FROM profiles p
       LEFT JOIN email_credentials c ON c.profile_id = p.id
      WHERE p.id = ? AND p.deleted_at IS NULL`,
  )
    .bind(c.get('profileId'))
    .first<ProfileRow & { unread: number; cred_email: string | null; cred_verified_at: string | null }>();

  // A token for a vanished profile is not a valid session.
  if (!row) return fail(c, 401, 'unauthenticated', 'No such profile.');

  /*
   * WHEN SOMEBODY LAST OPENED THE APP is stamped in `requireAuth`, not here.
   *
   * It was on this route, and the app calls this route from exactly two places:
   * the EMAIL sign-in path and the cover sync. So every Google and Apple member
   * read "never" on the dashboard however hard they were using the app — one
   * with 550 ratings and another with 24 comments both showed as having never
   * opened it. The figure was quietly measuring which sign-in somebody used.
   *
   * The middleware carries it now, with the same one-write-per-day guard, and
   * the note about what it can and cannot count.
   */

  /*
   * THE RENEWAL. This is the route every launch asks, so it is where a session
   * that is still in use gets its clock reset. Same profile, same scope, same
   * epoch — a renewal must never widen what a token can do, only how long it
   * lives. Older apps simply ignore the field and keep their token until it
   * expires; 1.6.4 stores it.
   */
  const nowMs = Date.now();
  const renewed =
    nowMs / 1000 - c.get('tokenIat') > RENEW_AFTER_SECONDS
      ? await sign(c.env, row.id, nowMs, c.get('scope'), c.get('tokenEpoch'))
      : null;

  return c.json({
    ...ownProfile(row),
    ...(renewed ? { session: { token: renewed.token, expires_at: renewed.expiresAt } } : {}),
    unread_notifications: row.unread,
    needs_handle: needsHandle(row.handle),
    // THE FREE MONTH (2.0.3). Whether the app may claim one at all — the
    // dashboard's switch — and how this account's month arrived, so a month
    // the dashboard GAVE (`free_month_via: 'gift'`) can be announced once on
    // the phone that never asked for it. Older apps ignore all three.
    free_month_open: await freeMonthOpen(c.env),
    free_month_at: row.free_month_at ?? null,
    free_month_via: row.free_month_via ?? null,
    // THE DATABASE'S ANSWER, not the token's. `requireVerified` reads the scope
    // baked into the session, which cannot change after it is issued — so an
    // account confirmed (or un-confirmed) since sign-in would otherwise never
    // reach the device. This is the route the app asks on every launch, and
    // these two fields are what let it put the confirm screen back.
    //
    // ABSENT ENTIRELY for Apple and Google accounts, which have no address of
    // ours to confirm. Undefined must not read as "unverified".
    ...(row.cred_email
      ? { email: row.cred_email, email_verified: row.cred_verified_at != null }
      : {}),
  });
});

// ── PATCH /v1/me ─────────────────────────────────────────────────────────────

/** Everything a user may change about themselves. Nothing else, ever. */
const PATCHABLE = [
  'display_name',
  'bio',
  'is_private',
  'links',
  'cover_url',
  'cover_frame',
  'theme_color',
  'theme_layout',
  'widgets',
  'hidden_sections',
  'heard_from',
] as const;

/**
 * "Where did you hear about OpenTV?" (2.0.3, asked once after the first sign-in).
 * A closed list, so the column can only ever hold a channel and never a name
 * or a sentence: what is wanted is which channel brings people, not whose path.
 */
export const HEARD_FROM = ['reddit', 'store', 'friend', 'creator', 'other'] as const;

/** Generous for twenty-odd widgets with a value each, small enough that a bad
 *  client cannot use a profile row as storage. */
const MAX_WIDGETS = 8000;

const MAX_DISPLAY_NAME = 100;
const MAX_BIO = 500;

auth.patch('/me', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(c, 400, 'invalid_body', 'Body must be an object.');
  }
  const b = body as Record<string, unknown>;

  // `is_plus`, `plus_since`, `plus_until`, `handle` and `tvtime_user_id` are
  // not merely ignored — the
  // whole body is refused, so a client that thinks it is granting itself Plus
  // finds out immediately (docs/IMPLEMENTATION.md §1d).
  const keys = Object.keys(b);
  if (keys.some((k) => !(PATCHABLE as readonly string[]).includes(k))) {
    return fail(c, 400, 'invalid_body', 'Only display_name, bio, is_private, links, cover_url, the theme fields, hidden_sections and heard_from may be changed.');
  }
  if (keys.length === 0) return fail(c, 400, 'invalid_body', 'Nothing to change.');

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];

  if ('display_name' in b) {
    const v = b.display_name;
    if (v !== null && typeof v !== 'string') return fail(c, 400, 'invalid_body', 'display_name must be a string or null.');
    const s = v === null ? null : v.trim();
    if (s !== null && s.length > MAX_DISPLAY_NAME) return fail(c, 400, 'invalid_body', 'display_name is too long.');
    sets.push('display_name = ?');
    binds.push(s && s.length > 0 ? s : null);
  }
  if ('bio' in b) {
    const v = b.bio;
    if (v !== null && typeof v !== 'string') return fail(c, 400, 'invalid_body', 'bio must be a string or null.');
    const s = v === null ? null : v.trim();
    if (s !== null && s.length > MAX_BIO) return fail(c, 400, 'invalid_body', 'bio is too long.');
    sets.push('bio = ?');
    binds.push(s && s.length > 0 ? s : null);
  }
  if ('is_private' in b) {
    const v = b.is_private;
    const ok = typeof v === 'boolean' || v === 0 || v === 1;
    if (!ok) return fail(c, 400, 'invalid_body', 'is_private must be a boolean.');
    sets.push('is_private = ?');
    binds.push(v === true || v === 1 ? 1 : 0);
  }
  if ('links' in b) {
    const v = b.links;
    const ok = v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!ok) return fail(c, 400, 'invalid_body', 'links must be an array of strings or null.');
    sets.push('links = ?');
    binds.push(v === null || (v as string[]).length === 0 ? null : JSON.stringify(v));
  }
  if ('cover_url' in b) {
    const v = b.cover_url;
    if (v !== null && typeof v !== 'string') return fail(c, 400, 'invalid_body', 'cover_url must be a string or null.');
    // A REFUSAL, NOT A SILENT NULL. Storing null for an address off the
    // allow-list would look to the phone like "saved" and to everyone else like
    // "no cover", and the user would keep re-picking a band that never appears.
    const url = v === null ? null : validCoverUrl(v);
    if (v !== null && url === null) {
      return fail(c, 400, 'invalid_body', `cover_url must be an https URL on ${COVER_HOSTS.join(' or ')}.`);
    }
    sets.push('cover_url = ?');
    binds.push(url);
  }

  const me = c.get('profileId');

  if ('theme_color' in b) {
    const v = b.theme_color;
    // #RRGGBB and nothing else — the value is rendered verbatim by every
    // visitor's phone, so the format check is the whole safety story.
    if (v !== null && (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v))) {
      return fail(c, 400, 'invalid_body', 'theme_color must be "#RRGGBB" or null.');
    }
    // SETTING the theme is Plus; CLEARING it never is. A lapsed subscriber
    // keeps the colour they chose — cosmetics are not stripped off people —
    // but choosing a new one is the paid act, checked here because a client
    // that lies about entitlement must not get the feature by PATCHing.
    if (v !== null) {
      const owner = await c.env.DB.prepare(
        'SELECT is_plus, plus_until FROM profiles WHERE id = ? AND deleted_at IS NULL',
      ).bind(me).first<{ is_plus: number; plus_until: string | null }>();
      if (!owner) return fail(c, 401, 'unauthenticated', 'No such profile.');
      if (!plusOn(owner, new Date().toISOString())) {
        return fail(c, 403, 'plus_required', 'A profile theme needs OpenTV Plus.');
      }
    }
    sets.push('theme_color = ?');
    binds.push(v === null ? null : (v as string).toUpperCase());
  }

  if ('cover_frame' in b) {
    // Moving and zooming the banner is everyone's; `tall` is Plus, and is
    // simply not sent to visitors once Plus lapses (`publicCoverFrame`).
    const v = validateCoverFrame(b.cover_frame);
    if (!v.ok) return fail(c, 400, 'invalid_body', 'cover_frame must be "x,y,zoom,size[,bg[,fade[,strength[,colour]]]]" or null.');
    sets.push('cover_frame = ?');
    binds.push(v.value);
  }

  if ('theme_layout' in b) {
    const v = b.theme_layout;
    // A closed set, checked here: the value is a rendering instruction to
    // every visitor's app, and an unknown one would be a profile that draws
    // nothing. Unsetting is always allowed, like the colour.
    if (v !== null && v !== 'classic' && v !== 'cards' && v !== 'poster') {
      return fail(c, 400, 'invalid_body', 'theme_layout must be "classic", "cards", "poster" or null.');
    }
    if (v !== null) {
      const owner = await c.env.DB.prepare(
        'SELECT is_plus, plus_until FROM profiles WHERE id = ? AND deleted_at IS NULL',
      ).bind(me).first<{ is_plus: number; plus_until: string | null }>();
      if (!owner) return fail(c, 401, 'unauthenticated', 'No such profile.');
      if (!plusOn(owner, new Date().toISOString())) {
        return fail(c, 403, 'plus_required', 'A profile layout needs OpenTV Plus.');
      }
    }
    sets.push('theme_layout = ?');
    binds.push(v);
  }

  if ('widgets' in b) {
    /*
     * THE ARRANGEMENT, VALIDATED AS SHAPE AND NOTHING MORE.
     *
     * This server does not know what a widget is and should not learn: the
     * catalogue lives in the app, gains entries every release, and a server
     * that validated widget ids would reject a profile arranged by a newer
     * build than itself. So the checks here are the ones a server can make
     * honestly — it is JSON, it is an array, it is not enormous.
     *
     * Plus-gated on the same reasoning as `theme_color` above: the value is
     * published to every visitor, and older apps will render whatever arrives
     * for ever. A lapsed subscription has to stop being paid-for here.
     */
    const v = b.widgets;
    if (v !== null) {
      if (typeof v !== 'string') return fail(c, 400, 'invalid_body', 'widgets must be a JSON string or null.');
      if (v.length > MAX_WIDGETS) return fail(c, 400, 'invalid_body', 'widgets is too large.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        return fail(c, 400, 'invalid_body', 'widgets must be valid JSON.');
      }
      if (!Array.isArray(parsed)) return fail(c, 400, 'invalid_body', 'widgets must be a JSON array.');
      const owner = await c.env.DB.prepare(
        'SELECT is_plus, plus_until FROM profiles WHERE id = ? AND deleted_at IS NULL',
      ).bind(me).first<{ is_plus: number; plus_until: string | null }>();
      if (!owner) return fail(c, 401, 'unauthenticated', 'No such profile.');
      if (!plusOn(owner, new Date().toISOString())) {
        return fail(c, 403, 'plus_required', 'Arranging a profile needs OpenTV Plus.');
      }
    }
    sets.push('widgets = ?');
    binds.push(v === null ? null : (v as string));
  }

  if ('hidden_sections' in b) {
    // NOT PLUS-GATED, unlike the two blocks above, and that is a decision
    // rather than an omission: the theme is a cosmetic somebody else sees, and
    // this is the user withholding their own things. Charging for privacy is
    // indefensible, and a lapsed subscriber's stats must not quietly reappear.
    const parsed = validateHiddenSections(b.hidden_sections);
    if (!parsed.ok) {
      return fail(
        c,
        400,
        'invalid_body',
        `hidden_sections must be null or an array of ${HIDEABLE_SECTIONS.join(', ')}.`,
      );
    }
    sets.push('hidden_sections = ?');
    binds.push(parsed.value);
  }

  if ('heard_from' in b) {
    const v = b.heard_from;
    if (typeof v !== 'string' || !(HEARD_FROM as readonly string[]).includes(v)) {
      return fail(c, 400, 'invalid_body', `heard_from must be one of ${HEARD_FROM.join(', ')}.`);
    }
    sets.push('heard_from = ?');
    binds.push(v);
  }

  const res = await c.env.DB.prepare(
    `UPDATE profiles SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(...binds, me)
    .run();
  if (res.meta.changes === 0) return fail(c, 401, 'unauthenticated', 'No such profile.');
  // A new name reaches CommsUni's other apps now, not on the next comment.
  if ('display_name' in b) c.executionCtx.waitUntil(refreshCommsuniProfile(c.env, me, new URL(c.req.url).origin).catch(() => {}));

  const row = await c.env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(me).first<ProfileRow>();
  return c.json(ownProfile(row!));
});

// ── POST /v1/me/handle ───────────────────────────────────────────────────────

auth.post('/me/handle', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.handle !== 'string') return fail(c, 400, 'invalid_body', 'handle is required.');
  if ('check_only' in b && typeof b.check_only !== 'boolean') {
    return fail(c, 400, 'invalid_body', 'check_only must be a boolean.');
  }
  /*
   * `tvtime_user_id` — OPTIONAL, and it is what an IMPORTED claim asserts.
   *
   * A handle claimed straight from somebody's GDPR export carries the numeric
   * id that export was issued to. Sending it is what lets the rule below apply;
   * a handle typed by hand carries nothing and is unaffected.
   */
  let claimedId: number | null = null;
  if (b.tvtime_user_id !== undefined && b.tvtime_user_id !== null) {
    if (typeof b.tvtime_user_id !== 'number' || !Number.isInteger(b.tvtime_user_id) || b.tvtime_user_id <= 0) {
      return fail(c, 400, 'invalid_body', 'tvtime_user_id must be a positive integer.');
    }
    claimedId = b.tvtime_user_id;
  }

  const check = isHandleValid(b.handle);
  if (!check.ok) {
    return fail(c, 400, 'handle_invalid', `That handle is not allowed (${check.reason}).`);
  }
  const lower = check.handle;
  // The stored `handle` is the normalised form: what the user typed differing
  // from what everyone sees would be a homograph vector by another name.
  const display = lower;
  const me = c.get('profileId');

  /*
   * ONE TV TIME ACCOUNT, ONE PROFILE.
   *
   * WHAT THIS ACTUALLY DEFENDS AGAINST, stated plainly because it is easy to
   * oversell: claiming a handle has always been first come, first served, and
   * nothing checked that the person claiming `@amanda` was the Amanda who wrote
   * nine years of comments under it. This does not fix that — an id proves you
   * hold an export, not that you are the person in it, and somebody who imports
   * a friend's export passes this as easily as its owner.
   *
   * WHAT IT DOES FIX is the cheap version of the attack: one export used over
   * and over to take name after name. A TV Time account belongs to one person,
   * so its id may sit on one profile. A squatter now needs a distinct real
   * export per name, which is the difference between a script and a project.
   *
   * GRANDFATHERED CLAIMS ARE UNTOUCHED. Every handle taken before this shipped
   * has a NULL id and stays exactly as valid as it was; this can only refuse a
   * claim that volunteers an id already spoken for.
   */
  if (claimedId != null) {
    const held = await c.env.DB.prepare(
      'SELECT id FROM profiles WHERE tvtime_user_id = ? AND id <> ? AND deleted_at IS NULL',
    )
      .bind(claimedId, me)
      .first<{ id: string }>();
    if (held) {
      return fail(
        c,
        409,
        'tvtime_id_claimed',
        'That TV Time account is already linked to another profile.',
      );
    }
  }

  if (b.check_only === true) {
    const taken = await c.env.DB.prepare(
      'SELECT 1 AS one FROM profiles WHERE handle_lower = ? AND id <> ?',
    )
      .bind(lower, me)
      .first();
    if (taken) return fail(c, 409, 'handle_taken', 'That handle is in use.');
    return c.json({ available: true });
  }

  try {
    /*
     * CHOOSING A NAME IS JOINING, so it is also the moment to be findable.
     *
     * Profiles are created private (0033/bb77831) because an account made only
     * for backup or sync must be nobody — and those people never reach this
     * route. Everybody who does is joining the community, and a member nobody
     * can find is the opposite of what they asked for: from 21 to 29 Sep every
     * new member arrived private without being asked. Only on the FIRST name,
     * leaving the `user_p_` placeholder; renaming a private profile keeps it
     * private. Settings still switches it either way.
     */
    const res = await c.env.DB.prepare(
      `UPDATE profiles SET handle = ?, handle_lower = ?,
              is_private = CASE WHEN handle LIKE 'user!_p!_%' ESCAPE '!' THEN 0 ELSE is_private END
       WHERE id = ? AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM profiles WHERE handle_lower = ? AND id <> ?)`,
    )
      .bind(display, lower, me, lower, me)
      .run();
    // Zero rows changed → someone else holds it (or the row is gone).
    if (res.meta.changes === 0) return fail(c, 409, 'handle_taken', 'That handle is in use.');
    /*
     * WRITE-ONCE, and only after the handle is actually won. `IS NULL` is the
     * whole guard: the id is a statement about which TV Time account this
     * profile is, and a profile does not become a different person later.
     * `reconcile.ts` writes the same column the same way, so whichever arrives
     * first wins and the second is a no-op rather than an overwrite.
     */
    if (claimedId != null) {
      await c.env.DB.prepare(
        'UPDATE profiles SET tvtime_user_id = ? WHERE id = ? AND tvtime_user_id IS NULL AND deleted_at IS NULL',
      )
        .bind(claimedId, me)
        .run();
    }
  } catch {
    // The check above is racy by construction; the UNIQUE index on
    // handle_lower is the real guarantee, so its error means the same thing.
    return fail(c, 409, 'handle_taken', 'That handle is in use.');
  }

  // The handle is the name CommsUni shows when there is no display name.
  c.executionCtx.waitUntil(refreshCommsuniProfile(c.env, me, new URL(c.req.url).origin).catch(() => {}));
  return c.json({ available: true, handle: display });
});

// ── DELETE /v1/me ────────────────────────────────────────────────────────────

auth.delete('/me', async (c) => {
  const me = c.get('profileId');
  const nowIso = new Date().toISOString();
  const db = c.env.DB;

  const row = await db
    .prepare('SELECT id, avatar_key FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first<{ id: string; avatar_key: string | null }>();
  if (!row) return fail(c, 401, 'unauthenticated', 'No such profile.');

  await db.batch([
    // Signing in again must create a NEW profile — that is what "deleted"
    // means to the user.
    db.prepare('DELETE FROM identities WHERE profile_id = ?').bind(me),
    // AND THE CREDENTIAL, or the address is burnt for ever. `email_lower` is
    // UNIQUE, so a surviving row means the person who just deleted their
    // account can never register that address again — and until registration
    // learned to clear the debris, it answered them with a 500. Deleting the
    // identity alone was never enough: this table is the other half of an
    // email sign-in, and it holds the password hash besides.
    db.prepare('DELETE FROM email_credentials WHERE profile_id = ?').bind(me),
    db.prepare('DELETE FROM comment_likes WHERE user_id = ?').bind(me),
    // Somebody else's IMPORTED replies that the archive attached to this
    // person's comments go back to waiting for their original, rather than
    // following them out through `ON DELETE CASCADE`: they are that other
    // person's own history, not a conversation this account started.
    db
      .prepare(
        `UPDATE comments SET parent_id = NULL
          WHERE tvtime_parent_id IS NOT NULL AND author_id <> ?
            AND parent_id IN (SELECT id FROM comments WHERE author_id = ?)`,
      )
      .bind(me, me),
    db.prepare('DELETE FROM comments WHERE author_id = ?').bind(me),
    db.prepare('DELETE FROM ratings WHERE author_id = ?').bind(me),
    db.prepare('DELETE FROM follows WHERE follower_id = ? OR followee_id = ?').bind(me, me),
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?').bind(me, me),
    db.prepare('DELETE FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE owner_id = ?)').bind(me),
    db.prepare('DELETE FROM lists WHERE owner_id = ?').bind(me),
    db.prepare('DELETE FROM notifications WHERE recipient_id = ?').bind(me),
    db.prepare('DELETE FROM support_messages WHERE profile_id = ?').bind(me),
    // The names of their phones (0054). The profiles row is only scrubbed
    // below, so the cascade never fires; said explicitly, like the rest.
    db.prepare('DELETE FROM devices WHERE profile_id = ?').bind(me),
    // A personal offer (0061) names nothing but a store offer and a date.
    db.prepare('DELETE FROM personal_offers WHERE profile_id = ?').bind(me),

    // The profiles row is SCRUBBED, not deleted. Hard-deleting would cascade
    // away the reports this person filed — silently defeating the 24-hour
    // moderation clock — and would be refused outright for anyone who has ever
    // moderated, because moderation_actions.moderator_id has no ON DELETE
    // clause. Step 5's job purges the shell after 30 days, by which time the
    // queue is long since resolved. No personal data survives in it.
    db
      .prepare(
        `UPDATE profiles SET
           deleted_at = ?,
           handle = 'deleted_' || substr(id, 3, 8),
           handle_lower = 'deleted_' || substr(id, 3, 8),
           display_name = NULL, bio = NULL, avatar_key = NULL, links = NULL,
           tvtime_user_id = NULL, tvtime_handle = NULL
         WHERE id = ?`,
      )
      .bind(nowIso, me),
  ]);

  // The avatar object. There is no R2 binding yet (avatars ship later, see
  // docs/IMPLEMENTATION.md Step 6), so this is guarded on both sides and
  // becomes live the day `AVATARS` is added to wrangler.jsonc.
  if (row.avatar_key && c.env.AVATARS) {
    try {
      await c.env.AVATARS.delete(row.avatar_key);
    } catch {
      // An orphaned object is swept by the Step 5 job; failing the deletion
      // over it would be the wrong trade.
    }
  }

  // Ratings are removed without correcting rating_aggregates: that drift is
  // expected and is exactly what the Step 5 reconciliation job exists for.
  //
  // Nothing here touches the phone. The app deletes nothing local on account
  // deletion and says so on the confirmation screen.
  return c.body(null, 204);
});
