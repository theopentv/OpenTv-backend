import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { rcExtend } from '@/routes/rc';

/**
 * A FREE MONTH OF PLUS FOR SIGNING IN (2.0.3).
 *
 * Every account gets thirty days of Plus once per campaign (2.1.0: it was once
 * for life, which shut out anybody from an earlier window at Christmas). No store trial and nothing that
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
 * dashboard's "Give Plus" follows. A PAYING SUBSCRIBER (`is_plus = 1`, 2.1.0)
 * gets the month at the store instead: their time is the store's, and a date
 * inside a period they already paid for is worth nothing. `rcExtend` moves the
 * renewal, the path the dashboard's Give uses. If the store refuses, or there
 * is nothing there to extend, the claim is handed back rather than spent: Apple
 * allows two extensions a year, so that refusal is real and needs a person.
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

// ponytail: a constant, so a new campaign is a deploy. Move it to KV beside the
// switch once campaigns come more often than releases.
export const FREE_MONTH_CAMPAIGN = 'christmas-2026';

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
    .prepare('SELECT is_plus, plus_until, free_month_at, free_month_campaign FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first<{
      is_plus: number | null;
      plus_until: string | null;
      free_month_at: string | null;
      free_month_campaign: string | null;
    }>();
  if (!row) return fail(c, 401, 'unauthenticated', 'No such profile.');

  const noStore = { 'Cache-Control': 'no-store' };
  // Before anything else, and without spending the claim: switched back on,
  // the same person may still take their month.
  if (!(await freeMonthOpen(c.env))) return c.json({ granted: false, reason: 'closed' }, 200, noStore);
  if (row.free_month_campaign === FREE_MONTH_CAMPAIGN) return c.json({ granted: false, reason: 'claimed' }, 200, noStore);
  const paying = row.is_plus === 1;

  const ids = await db
    .prepare('SELECT provider, external_id FROM identities WHERE profile_id = ?')
    .bind(me)
    .all<{ provider: string; external_id: string }>();
  const hashes = await Promise.all((ids.results ?? []).map((i) => subjectHash(c.env, `${FREE_MONTH_CAMPAIGN}:${i.provider}`, i.external_id)));
  if (hashes.length > 0) {
    const seen = await db
      .prepare(`SELECT 1 AS n FROM free_month_claims WHERE subject_hash IN (${hashes.map(() => '?').join(',')}) LIMIT 1`)
      .bind(...hashes)
      .first<{ n: number }>();
    if (seen) return c.json({ granted: false, reason: 'claimed' }, 200, noStore);
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  // A payer's end date is the store's: `plus_until` stays as it is.
  const until = paying ? row.plus_until : freeMonthUntil(row.plus_until, nowMs);
  /*
   * ONE BATCH, AND THE GUARD IS IN THE UPDATE. Two devices claiming in the same
   * instant both get past the reads above; the campaign test lets exactly one
   * UPDATE change a row, and the loser is told it was already claimed. Before
   * the store call for a payer too, so two taps cannot extend twice.
   */
  const results = await db.batch([
    db
      .prepare(
        `UPDATE profiles SET plus_until = ?, free_month_at = ?, free_month_campaign = ?
          WHERE id = ? AND free_month_campaign IS NOT ? AND deleted_at IS NULL`,
      )
      .bind(until, nowIso, FREE_MONTH_CAMPAIGN, me, FREE_MONTH_CAMPAIGN),
    ...hashes.map((h) =>
      db.prepare('INSERT OR IGNORE INTO free_month_claims (subject_hash, claimed_at) VALUES (?, ?)').bind(h, nowIso),
    ),
  ]);
  if (!results[0]?.meta.changes) return c.json({ granted: false, reason: 'claimed' }, 200, noStore);
  if (paying) {
    const store = await rcExtend(c.env, me, FREE_MONTH_DAYS);
    if (store?.ok) return c.json({ granted: true, plus_until: store.expires, via: 'store' }, 200, noStore);
    await db.batch([
      db
        .prepare('UPDATE profiles SET free_month_at = ?, free_month_campaign = ? WHERE id = ?')
        .bind(row.free_month_at, row.free_month_campaign, me),
      ...hashes.map((h) => db.prepare('DELETE FROM free_month_claims WHERE subject_hash = ?').bind(h)),
    ]);
    return c.json({ granted: false, reason: 'subscribed' }, 200, noStore);
  }
  return c.json({ granted: true, plus_until: until }, 200, noStore);
});
