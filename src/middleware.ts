import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { App, Env } from '@/env';
import { plusOn } from '@/pure';
import { fail } from '@/http';
import { verifyScoped } from '@/session';

/**
 * `Authorization: Bearer <session-jwt>`. Nothing else — no cookies, because
 * there is no browser client and cookies would drag CSRF into a design with no
 * need of it.
 *
 * Zero I/O by design (docs/IMPLEMENTATION.md §1c/§1e): the token is verified
 * inside the isolate. Whether the profile still exists is settled by the
 * handler's own statement, which filters `deleted_at IS NULL`.
 */
export const requireAuth = createMiddleware<App>(async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) return fail(c, 401, 'unauthenticated', 'Missing bearer token.');

  const session = await verifyScoped(c.env, match[1]!, Date.now());
  if (!session) return fail(c, 401, 'unauthenticated', 'Invalid or expired session.');

  c.set('profileId', session.profileId);
  c.set('scope', session.scope);
  // For `GET /v1/me`, which renews a token it finds old — see RENEW_AFTER_SECONDS.
  c.set('tokenIat', session.iat);
  c.set('tokenEpoch', session.ep);

  /*
   * "LAST OPENED", STAMPED WHEREVER THE APP TALKS TO US.
   *
   * This lived on `GET /v1/me`, and the app makes that call in exactly two
   * places: the EMAIL sign-in path, and the cover sync. So every Google and
   * Apple member read "never" on the dashboard for ever, however hard they were
   * using the app -- one member with 550 ratings and another with 24 comments
   * both showed as having never opened it. The number was quietly measuring
   * which sign-in somebody used.
   *
   * Here instead, because every route that needs a token is a moment the app is
   * demonstrably in somebody's hands: publishing a shelf, posting a comment,
   * fetching notifications. No route has to remember to do it, and a new one
   * cannot forget.
   *
   * AT MOST ONE WRITE PER MEMBER PER DAY. The `last_seen_at < today` guard means
   * a member who opens the app forty times costs one row, which is what makes
   * this safe to hang off every authenticated request rather than one.
   *
   * Fire and forget: knowing when somebody last opened the app is never worth
   * failing their request over.
   */
  const today = new Date().toISOString().slice(0, 10);
  /*
   * THE VERSION RIDES ALONG, on the same one-write-a-day guard.
   *
   * `api.ts` puts it on every request, so this needs no route of its own and no
   * second write. Validated rather than trusted: a header is whatever the
   * caller typed, and this one goes in a dashboard, so anything that is not a
   * short dotted number is dropped instead of stored.
   *
   * Kept out of the WHERE clause deliberately. Guarding on the version too
   * would write a row every time somebody updated, which is right, but it would
   * also mean a member who never updates is never stamped again — and the
   * once-a-day rule is what keeps this free.
   */
  const raw = c.req.header('X-OpenTV-Version') ?? '';
  const version = /^[0-9]{1,3}(\.[0-9]{1,3}){0,3}$/.test(raw) ? raw : null;
  // Why the phone's last publish sent nothing, if it did -- see 0051.
  const pub = c.req.header('X-OpenTV-Publish') ?? '';
  const publishState = /^[a-z_:]{1,40}$/.test(pub) ? pub : null;
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `UPDATE profiles SET last_seen_at = ?, app_version = COALESCE(?, app_version),
              publish_state = COALESCE(?, publish_state)
        WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
    )
      .bind(new Date().toISOString(), version, publishState, session.profileId, today)
      .run()
      .then((r) => {
        // The first open of the day, and only that one, also goes in the day
        // log the dashboard steps back through -- see 0038. Pruned per member,
        // so it never needs a job of its own: 500 days since 2 Nov 2026 (was
        // 90), so the dashboard can set a month against the same one a year
        // ago. A row is a member and a date, never what they did.
        if (!r.meta.changes) return;
        const cutoff = new Date(Date.now() - 500 * 86400000).toISOString().slice(0, 10);
        return c.env.DB.batch([
          c.env.DB.prepare('INSERT OR IGNORE INTO profile_days (profile_id, day) VALUES (?, ?)').bind(session.profileId, today),
          c.env.DB.prepare('DELETE FROM profile_days WHERE profile_id = ? AND day < ?').bind(session.profileId, cutoff),
        ]);
      })
      .catch(() => {}),
  );

  await next();
  return;
});

/**
 * NOTHING UNTIL THE EMAIL IS CONFIRMED.
 *
 * An account created with an address nobody has proved they can read is an
 * anonymous account with a display name. It must not be able to comment, rate,
 * follow, publish a profile, upload a picture, or LOOK AT ANYBODY — the last
 * one matters because a throwaway address would otherwise be a free window onto
 * every profile and everything they watch.
 *
 * What stays reachable while unverified, and why each has to:
 *   GET  /v1/me                  — the app must be able to draw its own state
 *   POST /v1/me/email/verify     — the way out of this state
 *   POST /v1/me/email/resend     — the way out when the first mail did not come
 *   DELETE /v1/me                — nobody is trapped in an account they regret
 *
 * Zero I/O, like the middleware above: the claim is in the token, and the only
 * way to get a token without it is to enter the code.
 */
export const requireVerified = createMiddleware<App>(async (c, next) => {
  if (c.get('scope') === 'unverified') {
    return fail(c, 403, 'email_unverified', 'Confirm your email address first.');
  }
  await next();
  return;
});


/**
 * Both ways Plus can be true — the webhook's flag, or a hand-granted date —
 * and a third that is not about payment at all.
 *
 * This lived twice, identically, in `backup.ts` and `sync.ts`. It is one
 * function now because the self-hosting rule below has to hold in both: a
 * person running their own instance is refused by their own server otherwise,
 * since `is_plus` is written by a RevenueCat webhook that a self-hosted box
 * never receives.
 */
export async function hasPlus(c: Context<App>): Promise<boolean> {
  return plusFor(c.env, c.get('profileId'));
}

/** The same question without a request context — the MCP server asks it on
 *  every tool call, where the profile comes from an OAuth grant, not a session. */
export async function plusFor(env: Env, profileId: string): Promise<boolean> {
  if (env.SELF_HOSTED) return true;
  const row = await env.DB.prepare(
    'SELECT is_plus, plus_until FROM profiles WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(profileId)
    .first<{ is_plus: number | null; plus_until: string | null }>();
  return row ? plusOn(row, new Date().toISOString()) : false;
}
