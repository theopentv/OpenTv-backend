import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';

/**
 * A FREE MONTH OF PLUS FOR SIGNING IN (2.0.3).
 *
 * Every account gets thirty days of Plus once. No store trial and nothing that
 * renews: the month is written into `plus_until`, the hand-grant lane gifting
 * already uses (`plusOn` reads `is_plus === 1 || plus_until > now`), so it
 * reaches the phone through the `/v1/me` it asks on every launch and ends on
 * its own with nothing to revoke.
 *
 * A CLAIM THE APP MAKES, NOT A SIDE EFFECT OF CREATING A PROFILE. Profiles are
 * made in three places (`resolveProfile`, email registration, the dev route)
 * and an unconfirmed email registration is one of them; granting there would
 * hand a month to an address nobody has proved. Here the global gate in
 * `index.ts` refuses an unverified token before this runs, so a month needs a
 * real sign-in, and the app asks once, right after one.
 *
 * NEVER SHORTER. A gifted month that still has three weeks left gets thirty
 * days added to its END, not a fresh thirty from today — the same rule the
 * dashboard's "Give Plus" follows. A paying subscriber (`is_plus = 1`) is
 * refused without spending the claim: their time is the store's, a date inside
 * a period they already paid for is worth nothing, and should they ever lapse
 * the month is still theirs to take.
 *
 * ONCE PER PERSON, NOT ONLY ONCE PER PROFILE — see 0063. Deleting an account
 * removes its identity rows, so "once per profile" alone would let anybody
 * delete and sign in again every thirty days. Every identity on the profile is
 * hashed into `free_month_claims`, and any one of them already there refuses
 * the claim. What this does NOT stop: a brand-new Google or Apple account, or a
 * new email address. That costs the person a new account each month and loses
 * them their profile, follows and comments each time, which is the ceiling
 * worth paying for a feature that has to work without a phone number.
 */
export const freeMonth = new Hono<App>();

export const FREE_MONTH_DAYS = 30;

/**
 * THE DASHBOARD'S SWITCH, in KV beside CommsUni's and the event's. '1' means
 * open; ABSENT MEANS CLOSED, so a fresh deploy (or a self-hosted instance that
 * never heard of the offer) grants nothing until somebody turns it on. Read by
 * the claim below and carried to the phone on `GET /v1/me` as
 * `free_month_open`, which is what stops the app asking at all.
 */
export const FREE_MONTH_OPEN_KEY = 'free-month:open';

export async function freeMonthOpen(env: Env): Promise<boolean> {
  return (await env.CACHE.get(FREE_MONTH_OPEN_KEY)) === '1';
}

/** The end of the free month: thirty days after whatever Plus is already granted, or after now. */
export function freeMonthUntil(current: string | null, nowMs: number): string {
  const cur = current ? Date.parse(current) : NaN;
  const from = Number.isFinite(cur) && cur > nowMs ? cur : nowMs;
  return new Date(from + FREE_MONTH_DAYS * 86_400_000).toISOString();
}

/**
 * HMAC, NOT A PLAIN HASH. A SHA-256 of an email address is reversed by hashing
 * a list of addresses; keyed with SESSION_SECRET it is not. Rotating the secret
 * forgets every claim, which signs everybody out anyway and costs at most one
 * extra month per person.
 */
export async function subjectHash(env: Env, provider: string, subject: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SESSION_SECRET ?? ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`free-month:${provider}:${subject}`));
  return Buffer.from(new Uint8Array(mac)).toString('hex');
}

freeMonth.post('/me/free-month', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const row = await db
    .prepare('SELECT is_plus, plus_until, free_month_at FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first<{ is_plus: number | null; plus_until: string | null; free_month_at: string | null }>();
  if (!row) return fail(c, 401, 'unauthenticated', 'No such profile.');

  const noStore = { 'Cache-Control': 'no-store' };
  // Before anything else, and without spending the claim: switched back on,
  // the same person may still take their month.
  if (!(await freeMonthOpen(c.env))) return c.json({ granted: false, reason: 'closed' }, 200, noStore);
  if (row.free_month_at) return c.json({ granted: false, reason: 'claimed' }, 200, noStore);
  if (row.is_plus === 1) return c.json({ granted: false, reason: 'subscribed' }, 200, noStore);

  const ids = await db
    .prepare('SELECT provider, external_id FROM identities WHERE profile_id = ?')
    .bind(me)
    .all<{ provider: string; external_id: string }>();
  const hashes = await Promise.all((ids.results ?? []).map((i) => subjectHash(c.env, i.provider, i.external_id)));
  if (hashes.length > 0) {
    const seen = await db
      .prepare(`SELECT 1 AS n FROM free_month_claims WHERE subject_hash IN (${hashes.map(() => '?').join(',')}) LIMIT 1`)
      .bind(...hashes)
      .first<{ n: number }>();
    if (seen) return c.json({ granted: false, reason: 'claimed' }, 200, noStore);
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const until = freeMonthUntil(row.plus_until, nowMs);
  /*
   * ONE BATCH, AND THE GUARD IS IN THE UPDATE. Two devices claiming in the same
   * instant both get past the reads above; `free_month_at IS NULL` lets exactly
   * one UPDATE change a row, and the loser is told it was already claimed.
   */
  const results = await db.batch([
    db
      .prepare('UPDATE profiles SET plus_until = ?, free_month_at = ? WHERE id = ? AND free_month_at IS NULL AND deleted_at IS NULL')
      .bind(until, nowIso, me),
    ...hashes.map((h) =>
      db.prepare('INSERT OR IGNORE INTO free_month_claims (subject_hash, claimed_at) VALUES (?, ?)').bind(h, nowIso),
    ),
  ]);
  if (!results[0]?.meta.changes) return c.json({ granted: false, reason: 'claimed' }, 200, noStore);
  return c.json({ granted: true, plus_until: until }, 200, noStore);
});
