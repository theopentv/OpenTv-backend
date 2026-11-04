import { Hono } from 'hono';
import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { hasPlus, plusFor, requireAuth } from '@/middleware';
import { normaliseEmail } from '@/pure';
import { overBudget, type Budget } from '@/rate-limit';
import { bestBackupKey } from '@/routes/backup';
import { checkEmailPassword } from '@/routes/email-auth';

/**
 * Linking OpenTV to Claude or ChatGPT (2.3.0, Plus). The MCP server itself is
 * `src/mcp/`; this is the door to it, in two halves.
 *
 * ON THE PHONE: `POST /v1/mcp/code` hands a signed-in member a six-digit code,
 * and the connection routes list and remove what they have linked.
 *
 * IN THE BROWSER: `/authorize` is the page Claude or ChatGPT opens. It asks for
 * that code — or, second and folded away, the OpenTV email and password.
 *
 * WHY A CODE AND NOT A WEB SIGN-IN. OpenTV has no web sign-in: an account is
 * Apple, Google or an email on the phone, and building a second way in on the
 * web for one feature would be a second thing to secure for ever. The phone is
 * already signed in, so the phone vouches. Five minutes, single use, and a new
 * request throws the last one away — it is a one-time pairing, not a password.
 *
 * THE EMAIL FORM IS FOR PEOPLE WITHOUT THE PHONE TO HAND, starting with the
 * ChatGPT and Claude directory reviewers, who are handed "a login and password
 * for a demo account" and cannot press a button in our app. It is the same
 * credential the app's email sign-in takes, checked by the same function
 * (`checkEmailPassword`), so it is not a second way in to secure — only a
 * second form in front of the one that exists. Unverified addresses are
 * refused: an unconfirmed address proves nobody.
 *
 * WHAT THE CODE IS WORTH TO A GUESSER. A million values, a handful alive at any
 * moment (one per member who pressed the button in the last five minutes), and
 * ten tries per address per ten minutes. Odds of a hit are a few in a hundred
 * thousand per address per window, and a hit reads one library and can relay
 * changes to it (additions, ratings, un-marking an episode — never a deletion
 * of the library) — while the page shows the member which app is asking.
 */
export const mcp = new Hono<App>();
/** `/authorize`, mounted at the root: it is a page a browser opens, not API. */
export const mcpAuthorize = new Hono<App>();

const CODE_TTL_SECONDS = 300;
/** A member pressing "get a code" a few times while their laptop catches up. */
const CODE_BUDGET: Budget = { limit: 5, windowSeconds: 60 };
/** Wrong codes typed into the page, per address. */
const ATTEMPT_BUDGET: Budget = { limit: 10, windowSeconds: 600 };
/** Passwords tried against one address from the page, wherever they come from.
 *  The account's own lock (`LOGIN_FAIL_LIMIT`) sits behind this as well. */
const EMAIL_BUDGET: Budget = { limit: 5, windowSeconds: 600 };

const consentKey = (handle: string) => `mcp:consent:${handle}`;

/** Six uniform digits. Rejection sampling, because `% 1e6` on a 32-bit value
 *  makes the low codes slightly likelier — small, and free to avoid. */
function sixDigits(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < 4_294_000_000) return String(buf[0]! % 1_000_000).padStart(6, '0');
  }
}

/**
 * The code's owner, ONCE. Deleted on the first read whatever happens next, so a
 * code that met a page cannot meet a second one. The expiry is checked here as
 * well as left to KV's TTL: KV's is a floor of 60 seconds and lazily enforced,
 * and "five minutes" should mean five minutes.
 *
 * ponytail: KV deletes are eventually consistent across locations, so a code
 * read at two edges within ~60 s could be used twice. Both uses would need the
 * code AND a consent page; a Durable Object counter closes it if it ever matters.
 */
export async function consumeCode(env: Env, code: string, nowMs: number): Promise<string | null> {
  if (!/^\d{6}$/.test(code)) return null;
  // Gone the moment it is read, in one statement: a code meets one page.
  const row = await env.DB.prepare('DELETE FROM mcp_codes WHERE code = ? RETURNING profile_id, expires_at')
    .bind(code)
    .first<{ profile_id: string; expires_at: number }>();
  if (!row || row.expires_at < nowMs) return null;
  return row.profile_id;
}

mcp.post('/mcp/code', requireAuth, async (c) => {
  const profileId = c.get('profileId');
  if (await overBudget(c.env, 'mcp-code', profileId, CODE_BUDGET, Date.now())) {
    return fail(c, 429, 'rate_limited', 'Too many codes. Wait a minute.');
  }
  if (!(await hasPlus(c))) return fail(c, 402, 'plus_required', 'Claude and ChatGPT need OpenTV Plus.');
  // The MCP server reads the backup and nothing else, so without one a
  // connection would answer every question with "turn on Backup". Better to
  // say it here, once, where the switch is.
  const bucket = c.env.BACKUPS;
  if (!bucket || !(await bestBackupKey(bucket, profileId))) {
    return fail(c, 409, 'no_backup', 'Turn on OpenTV Backup first: Claude and ChatGPT read your backup.');
  }

  const now = Date.now();
  const exp = now + CODE_TTL_SECONDS * 1000;
  // A new code replaces the last one, so only the code on screen works; and
  // expired codes are swept while we are here.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM mcp_codes WHERE profile_id = ? OR expires_at < ?').bind(profileId, now),
  ]);
  // Another member's live code: astronomically rare, and handing out a
  // duplicate would link the wrong library, so the primary key refuses it and
  // a fresh code is drawn.
  for (let i = 0; i < 5; i++) {
    const code = sixDigits();
    const put = await c.env.DB.prepare('INSERT OR IGNORE INTO mcp_codes (code, profile_id, expires_at) VALUES (?, ?, ?)')
      .bind(code, profileId, exp)
      .run();
    if (put.meta.changes === 1) return c.json({ code, expiresAt: new Date(exp).toISOString() });
  }
  return fail(c, 503, 'unavailable', 'Could not make a code, try again.');
});

// ── what is linked ───────────────────────────────────────────────────────────

/** The library stores `createdAt` in seconds; an ISO date is what the app reads. */
const iso = (t: number) => new Date(t < 1e12 ? t * 1000 : t).toISOString();

mcp.get('/mcp/connections', requireAuth, async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) return fail(c, 503, 'not_configured', 'Claude and ChatGPT are not available on this server.');
  const { items } = await oauth.listUserGrants(c.get('profileId'), { limit: 100 });
  return c.json({
    connections: items.map((g) => ({
      id: g.id,
      client: typeof g.metadata?.client === 'string' ? g.metadata.client : g.clientId,
      createdAt: iso(g.createdAt),
    })),
  });
});

mcp.delete('/mcp/connections/:id', requireAuth, async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) return fail(c, 503, 'not_configured', 'Claude and ChatGPT are not available on this server.');
  const profileId = c.get('profileId');
  // Looked up among THIS member's grants first. The library keys grants by
  // user, so revoking somebody else's id under your own would be a no-op
  // anyway — but a 404 says so, where a silent `ok` would say it worked.
  const { items } = await oauth.listUserGrants(profileId, { limit: 1000 });
  if (!items.some((g) => g.id === c.req.param('id'))) return fail(c, 404, 'not_found', 'No such connection.');
  await oauth.revokeGrant(c.req.param('id'), profileId);
  return c.json({ ok: true });
});

// ── the page Claude and ChatGPT open ─────────────────────────────────────────

/** What the page shows, kept between GET and a wrong-code POST. Only what the
 *  library's `describeConsent` said, never anything from the form. */
type ConsentView = Pick<ConsentDescription, 'clientName' | 'clientDomain' | 'redirectHost' | 'redirectIsLoopback' | 'scope'>;

const escape = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Errors the library throws on purpose carry a name; checked by name because
 *  importing its classes would pull `cloudflare:workers` into Node. */
const named = (e: unknown, name: string): e is Error & { description?: string; redirectTo?: string } =>
  e instanceof Error && e.name === name;

const NO_FRAMES = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" };

function page(body: string, status = 200, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set('Content-Type', 'text/html; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  h.set('X-Robots-Tag', 'noindex');
  for (const [k, v] of Object.entries(NO_FRAMES)) if (!h.has(k)) h.set(k, v);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenTV</title>
<style>
  body { margin: 0; background: #000; color: #fff; font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 420px; margin: 0 auto; padding: 40px 20px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { color: #A7A7AE; margin: 0 0 14px; }
  strong { color: #fff; }
  .warn { color: #fff; background: #141416; border-left: 3px solid #E5484D; padding: 10px 12px; }
  .err { color: #E5484D; }
  input { width: 100%; box-sizing: border-box; background: #1C1C1E; color: #fff; border: 1px solid #333; border-radius: 10px;
          font-size: 28px; letter-spacing: 8px; text-align: center; padding: 12px; margin: 6px 0 16px; }
  input.field { font-size: 17px; letter-spacing: normal; text-align: left; margin: 4px 0 12px; }
  details { margin-top: 26px; border-top: 1px solid #1C1C1E; padding-top: 16px; }
  summary { color: #A7A7AE; cursor: pointer; }
  summary strong { color: #FFD400; }
  label.small { color: #A7A7AE; font-size: 14px; }
  .row { display: flex; gap: 10px; }
  button { flex: 1; border: 0; border-radius: 10px; padding: 14px; font-size: 17px; font-weight: 600; cursor: pointer; }
  .allow { background: #FFD400; color: #000; }
  .deny { background: #1C1C1E; color: #fff; }
  small { color: #6B6B72; display: block; margin-top: 18px; }
</style></head><body><main>${body}</main></body></html>`,
    { status, headers: h },
  );
}

/** Which form an error belongs to, and the address to put back after a wrong
 *  password (never the password). */
type Failed = { via: 'code' | 'email'; error: string; email?: string };

function consentPage(v: ConsentView, handle: string, failed: Failed | null, status = 200, headers?: Headers): Response {
  const name = escape(v.clientName);
  const codeError = failed?.via === 'code' ? failed.error : null;
  const emailError = failed?.via === 'email' ? failed.error : null;
  const origin = v.clientDomain
    ? `Published by <strong>${escape(v.clientDomain)}</strong>.`
    : 'This app named itself; the name is not verified.';
  return page(
    `<h1>Let ${name} use your OpenTV library?</h1>
<p>${origin} Access goes to <strong>${escape(v.redirectHost)}</strong>.</p>
${v.redirectIsLoopback ? '<p class="warn">This sends access to an app on this computer. Continue only if you just started connecting from it.</p>' : ''}
<p>It can read what is in your OpenTV backup: what you watched and when, your ratings and your lists.</p>
<p>It can also mark episodes and films watched, rate them, add to your watchlist and set how an episode made you feel. ${name} asks you before each change, and it reaches your phone through Sync.</p>
<form method="post" autocomplete="off">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="code"><p>Enter the code from the OpenTV app: <strong>Profile → ••• → Settings → Library tab → Claude &amp; ChatGPT</strong> → Get a code.</p></label>
  ${codeError ? `<p class="err">${escape(codeError)}</p>` : ''}
  <input id="code" name="code" inputmode="numeric" pattern="[0-9 ]*" maxlength="7" placeholder="000000"${emailError ? '' : ' autofocus'}>
  <div class="row"><button class="deny" name="decision" value="deny">Deny</button><button class="allow" name="decision" value="approve">Allow</button></div>
</form>
<details${emailError ? ' open' : ''}>
  <summary>No code? <strong>Sign in with your OpenTV email instead</strong></summary>
  <form method="post">
    <input type="hidden" name="handle" value="${escape(handle)}">
    <input type="hidden" name="via" value="email">
    ${emailError ? `<p class="err">${escape(emailError)}</p>` : ''}
    <label class="small" for="email">Email</label>
    <input class="field" id="email" name="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" required value="${escape(failed?.email ?? '')}"${emailError ? ' autofocus' : ''}>
    <label class="small" for="password">Password</label>
    <input class="field" id="password" name="password" type="password" autocomplete="current-password" required>
    <div class="row"><button class="deny" name="decision" value="deny" formnovalidate>Deny</button><button class="allow" name="decision" value="approve">Allow</button></div>
  </form>
</details>
<small>Remove it any time in the same place in the app.</small>`,
    status,
    headers,
  );
}

const stopped = (message: string, status = 400) =>
  page(`<h1>That didn't work</h1><p>${escape(message)}</p><p>Start connecting again from Claude or ChatGPT.</p>`, status);

mcpAuthorize.get('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) return stopped('Claude and ChatGPT are not available on this server.', 404);
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    const d = await oauth.describeConsent(request); // first: a failed lookup leaves nothing in KV
    const consent = await oauth.beginConsent(request);
    const view: ConsentView = {
      clientName: d.clientName,
      clientDomain: d.clientDomain,
      redirectHost: d.redirectHost,
      redirectIsLoopback: d.redirectIsLoopback,
      scope: d.scope,
    };
    // Ten minutes, the handle's own life: long enough to fetch the code.
    await c.env.CACHE.put(consentKey(consent.handle), JSON.stringify(view), { expirationTtl: 600 });
    return consentPage(view, consent.handle, null, 200, consent.headers);
  } catch (e) {
    if (named(e, 'AuthorizationError') && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (named(e, 'AuthorizationError')) return stopped(e.description ?? 'The request was not valid.');
    if (named(e, 'CimdFetchError')) return stopped('This app could not be verified.');
    throw e;
  }
});

mcpAuthorize.post('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) return stopped('Claude and ChatGPT are not available on this server.', 404);
  const form = await c.req.formData();
  const handle = String(form.get('handle') ?? '');
  try {
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      await c.env.CACHE.delete(consentKey(handle));
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const view = (await c.env.CACHE.get(consentKey(handle), 'json')) as ConsentView | null;
    if (!view) return stopped('This page has expired.');

    // A WRONG CODE KEEPS THE HANDLE. The library burns a handle on approve or
    // deny, so the code (or password) is checked BEFORE either: a typo re-shows
    // the same page instead of sending somebody back to Claude to start over.
    const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';
    const now = Date.now();
    let profileId: string | null;
    if (form.get('via') === 'email') {
      const typed = String(form.get('email') ?? '').slice(0, 254);
      const again = (error: string, status: number) => consentPage(view, handle, { via: 'email', error, email: typed }, status);
      const email = normaliseEmail(typed);
      const password = String(form.get('password') ?? '');
      // Per address AND per IP: one address tried from many machines, and many
      // addresses tried from one. Same IP bucket as the codes, so switching
      // forms buys a guesser nothing.
      if (
        (await overBudget(c.env, 'mcp-authorize', ip, ATTEMPT_BUDGET, now)) ||
        (email && (await overBudget(c.env, 'mcp-authorize-email', email, EMAIL_BUDGET, now)))
      ) {
        return again('Too many tries. Wait a few minutes.', 429);
      }
      // One sentence for no account, no password, a wrong one and a locked
      // one: the page must not say which addresses have an account.
      const check = email && password ? await checkEmailPassword(c.env, email, password, now) : null;
      if (!check?.ok) return again('Wrong email or password.', 400);
      // Past the password, so saying it concedes nothing to a stranger.
      if (!check.row.verified_at) return again('Confirm this email address in the OpenTV app first.', 403);
      profileId = check.row.profile_id;
    } else {
      if (await overBudget(c.env, 'mcp-authorize', ip, ATTEMPT_BUDGET, now)) {
        return consentPage(view, handle, { via: 'code', error: 'Too many tries. Wait a few minutes, then get a new code.' }, 429);
      }
      const code = String(form.get('code') ?? '').replace(/\D/g, '');
      profileId = await consumeCode(c.env, code, now);
      if (!profileId) {
        return consentPage(view, handle, { via: 'code', error: 'That code is wrong or has expired. Get a new one in the app.' }, 400);
      }
    }
    if (!(await plusFor(c.env, profileId))) {
      const error = 'This OpenTV account does not have Plus, which Claude and ChatGPT need.';
      return consentPage(view, handle, { via: form.get('via') === 'email' ? 'email' : 'code', error }, 402);
    }

    // `offline_access` only when asked for; reading and writing always, which
    // is what the page just described (clients rarely ask for `mcp:write` by
    // name, and the library allows granting more than was requested).
    const scope = ['mcp:read', 'mcp:write', ...(view.scope.includes('offline_access') ? ['offline_access'] : [])];
    const approved = await oauth.approveConsent(c.req.raw, handle, { scope });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: profileId,
      // Visible in storage, unlike props: so only the app's display name.
      metadata: { client: view.clientDomain ? `${view.clientName} (${view.clientDomain})` : view.clientName },
      scope: approved.request.scope,
      props: { profileId },
    });
    await c.env.CACHE.delete(consentKey(handle));
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    if (named(e, 'AuthorizationError') || named(e, 'CimdFetchError')) return stopped('This page has expired or was already used.');
    throw e;
  }
});
