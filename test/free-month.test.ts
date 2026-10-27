import { describe, expect, it } from 'vitest';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';
import { FREE_MONTH_OPEN_KEY, freeMonthUntil } from '@/routes/free-month';
import type { Env } from '@/env';
import { sign } from '@/session';

/**
 * The free month of Plus (2.0.3). It grants entitlement, so most of what is
 * worth pinning is a refusal: twice, to a subscriber, to a deleted-and-back
 * account, and never a date shorter than one already granted.
 */

const DAY = 86_400_000;

/** The offer switched ON, as it will be once Mahmood turns it on: most tests are about the claim. */
async function seed(open = true) {
  const { raw, db } = freshDatabase();
  insertProfile(raw, 'p_me', 'me');
  raw
    .prepare("INSERT INTO identities (provider, external_id, profile_id, created_at) VALUES ('google', 'sub-1', 'p_me', '2026-01-01T00:00:00.000Z')")
    .run();
  const env = makeEnv(db);
  if (open) await env.CACHE.put(FREE_MONTH_OPEN_KEY, '1');
  return { raw, env };
}

const until = (raw: ReturnType<typeof freshDatabase>['raw'], id = 'p_me') =>
  (raw.prepare('SELECT plus_until FROM profiles WHERE id = ?').get(id) as { plus_until: string | null }).plus_until;

describe('freeMonthUntil', () => {
  it('starts today when nothing is granted, and adds to the end of a grant still running', () => {
    const now = Date.parse('2026-10-27T00:00:00.000Z');
    expect(freeMonthUntil(null, now)).toBe('2026-11-26T00:00:00.000Z');
    expect(freeMonthUntil('2026-11-10T00:00:00.000Z', now)).toBe('2026-12-10T00:00:00.000Z');
    // An expired grant starts from today, not from the past.
    expect(freeMonthUntil('2026-01-01T00:00:00.000Z', now)).toBe('2026-11-26T00:00:00.000Z');
  });
});

describe('POST /v1/me/free-month', () => {
  it('grants thirty days into plus_until, and /v1/me then says Plus', async () => {
    const { raw, env } = await seed();
    const token = await tokenFor(env, 'p_me');
    const res = await call(env, 'POST', '/v1/me/free-month', { token });
    expect(res.status).toBe(200);
    expect(res.json.granted).toBe(true);
    expect(Date.parse(res.json.plus_until)).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(until(raw)).toBe(res.json.plus_until);
    // A grant, never the subscription flag the webhook owns.
    expect((raw.prepare('SELECT is_plus FROM profiles WHERE id = ?').get('p_me') as { is_plus: number }).is_plus).toBe(0);
    const me = await call(env, 'GET', '/v1/me', { token });
    expect(me.json.is_plus).toBe(true);
  });

  it('is once per account', async () => {
    const { raw, env } = await seed();
    const token = await tokenFor(env, 'p_me');
    const first = await call(env, 'POST', '/v1/me/free-month', { token });
    const second = await call(env, 'POST', '/v1/me/free-month', { token });
    expect(second.json).toEqual({ granted: false, reason: 'claimed' });
    expect(until(raw)).toBe(first.json.plus_until);
  });

  it('never shortens a gift that is still running', async () => {
    const { raw, env } = await seed();
    const later = new Date(Date.now() + 60 * DAY).toISOString();
    raw.prepare('UPDATE profiles SET plus_until = ? WHERE id = ?').run(later, 'p_me');
    const res = await call(env, 'POST', '/v1/me/free-month', { token: await tokenFor(env, 'p_me') });
    expect(res.json.granted).toBe(true);
    expect(Date.parse(until(raw)!)).toBe(Date.parse(later) + 30 * DAY);
  });

  it('is open to somebody whose earlier gifted Plus has ended', async () => {
    const { raw, env } = await seed();
    // A hand gift from the dashboard's "Give Plus", long over: never a free month.
    raw.prepare("UPDATE profiles SET plus_until = '2026-03-01T00:00:00.000Z' WHERE id = 'p_me'").run();
    const token = await tokenFor(env, 'p_me');
    expect((await call(env, 'GET', '/v1/me', { token })).json).toMatchObject({ is_plus: false, free_month_at: null });
    const res = await call(env, 'POST', '/v1/me/free-month', { token });
    expect(res.json.granted).toBe(true);
    expect(Date.parse(until(raw)!)).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  it('leaves a paying subscriber alone, without spending their claim', async () => {
    const { raw, env } = await seed();
    raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run('p_me');
    const res = await call(env, 'POST', '/v1/me/free-month', { token: await tokenFor(env, 'p_me') });
    expect(res.json).toEqual({ granted: false, reason: 'subscribed' });
    expect(until(raw)).toBeNull();
    expect((raw.prepare('SELECT COUNT(*) AS n FROM free_month_claims').get() as { n: number }).n).toBe(0);
  });

  it('is not given again after deleting the account and signing in with the same Google account', async () => {
    const { raw, env } = await seed();
    const token = await tokenFor(env, 'p_me');
    await call(env, 'POST', '/v1/me/free-month', { token });
    expect((await call(env, 'DELETE', '/v1/me', { token })).status).toBe(204);
    // The new profile resolveProfile would make for the same subject.
    insertProfile(raw, 'p_again', 'again');
    raw
      .prepare("INSERT INTO identities (provider, external_id, profile_id, created_at) VALUES ('google', 'sub-1', 'p_again', '2026-10-27T00:00:00.000Z')")
      .run();
    const res = await call(env, 'POST', '/v1/me/free-month', { token: await tokenFor(env, 'p_again') });
    expect(res.json).toEqual({ granted: false, reason: 'claimed' });
    expect(until(raw, 'p_again')).toBeNull();
  });

  it('stores no subject in the clear', async () => {
    const { raw, env } = await seed();
    await call(env, 'POST', '/v1/me/free-month', { token: await tokenFor(env, 'p_me') });
    const rows = raw.prepare('SELECT subject_hash FROM free_month_claims').all() as { subject_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.subject_hash).not.toContain('sub-1');
  });

  it('refuses an email account that has not confirmed its address', async () => {
    const { raw, env } = await seed();
    const { token } = await sign(env, 'p_me', Date.now(), 'unverified');
    const res = await call(env, 'POST', '/v1/me/free-month', { token });
    expect(res.status).toBe(403);
    expect(until(raw)).toBeNull();
  });

  it('grants nothing while the dashboard switch is off, and keeps the claim for later', async () => {
    const { raw, env } = await seed(false);
    const token = await tokenFor(env, 'p_me');
    expect((await call(env, 'POST', '/v1/me/free-month', { token })).json).toEqual({ granted: false, reason: 'closed' });
    expect(until(raw)).toBeNull();
    expect((raw.prepare('SELECT COUNT(*) AS n FROM free_month_claims').get() as { n: number }).n).toBe(0);
    await env.CACHE.put(FREE_MONTH_OPEN_KEY, '1');
    expect((await call(env, 'POST', '/v1/me/free-month', { token })).json.granted).toBe(true);
  });

  it('needs a session', async () => {
    const { env } = await seed();
    expect((await call(env, 'POST', '/v1/me/free-month')).status).toBe(401);
  });
});

describe('PATCH /v1/me heard_from', () => {
  it('takes one of the five channels and nothing else', async () => {
    const { raw, env } = await seed();
    const token = await tokenFor(env, 'p_me');
    expect((await call(env, 'PATCH', '/v1/me', { token, body: { heard_from: 'reddit' } })).status).toBe(200);
    expect((raw.prepare('SELECT heard_from FROM profiles WHERE id = ?').get('p_me') as { heard_from: string }).heard_from).toBe('reddit');
    expect((await call(env, 'PATCH', '/v1/me', { token, body: { heard_from: 'r/television' } })).status).toBe(400);
    expect((raw.prepare('SELECT heard_from FROM profiles WHERE id = ?').get('p_me') as { heard_from: string }).heard_from).toBe('reddit');
  });
});

describe('GET /v1/me free month fields', () => {
  it('says whether the offer is open, and whether this account had its month', async () => {
    const { raw, env } = await seed(false);
    const token = await tokenFor(env, 'p_me');
    let me = await call(env, 'GET', '/v1/me', { token });
    expect(me.json).toMatchObject({ free_month_open: false, free_month_at: null });
    expect(me.json.free_month_via).toBeUndefined();
    await env.CACHE.put(FREE_MONTH_OPEN_KEY, '1');
    raw.prepare("UPDATE profiles SET free_month_at = '2026-10-27T00:00:00.000Z' WHERE id = 'p_me'").run();
    me = await call(env, 'GET', '/v1/me', { token });
    expect(me.json).toMatchObject({ free_month_open: true, free_month_at: '2026-10-27T00:00:00.000Z' });
  });
});

// ── the dashboard ────────────────────────────────────────────────────────────

async function adminEnv() {
  const { raw, env: base } = await seed(false);
  const env = { ...base, ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' } as Env;
  const res = await call(env, 'POST', '/v1/admin/login', { body: { email: 'me@example.com', password: 'a-long-one' } });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const as = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    call(env, method, path, { body, headers: { Cookie: cookie } });
  return { raw, env, as };
}

function person(raw: ReturnType<typeof freshDatabase>['raw'], id: string, subject: string) {
  insertProfile(raw, id, id);
  raw
    .prepare("INSERT INTO identities (provider, external_id, profile_id, created_at) VALUES ('google', ?, ?, '2026-01-01T00:00:00.000Z')")
    .run(subject, id);
}

const fmRow = (raw: ReturnType<typeof freshDatabase>['raw'], id: string) =>
  raw.prepare('SELECT plus_until, free_month_at, free_month_via FROM profiles WHERE id = ?').get(id) as {
    plus_until: string | null;
    free_month_at: string | null;
    free_month_via: string | null;
  };

describe('dashboard: the free month switch', () => {
  it('is off on a fresh deploy, turns on and off, and needs the admin cookie', async () => {
    const { env, as } = await adminEnv();
    expect((await as('GET', '/v1/admin/free-month')).json.open).toBe(false);
    expect((await call(env, 'POST', '/v1/admin/free-month/open', { body: { open: true } })).status).toBe(401);
    expect((await as('POST', '/v1/admin/free-month/open', { open: 'yes' })).status).toBe(400);
    expect((await as('POST', '/v1/admin/free-month/open', { open: true })).json).toEqual({ open: true });
    expect((await as('GET', '/v1/admin/free-month')).json.open).toBe(true);
    await as('POST', '/v1/admin/free-month/open', { open: false });
    expect(await env.CACHE.get(FREE_MONTH_OPEN_KEY)).toBeNull();
  });
});

describe('dashboard: no bulk gift', () => {
  it('has no "give everyone a month" route any more: the month is opt-in only', async () => {
    const { raw, as } = await adminEnv();
    expect((await as('POST', '/v1/admin/free-month/grant', {})).status).toBe(404);
    expect(fmRow(raw, 'p_me').free_month_at).toBeNull();
  });
});

describe('dashboard: free month stats', () => {
  it('counts claims, claims by day, payers after a month, and where people heard of us', async () => {
    const { raw, as } = await adminEnv();
    const today = new Date().toISOString();
    raw.prepare("UPDATE profiles SET free_month_at = ?, heard_from = 'reddit' WHERE id = 'p_me'").run(today);
    person(raw, 'p_paid', 'sp');
    raw.prepare("UPDATE profiles SET free_month_at = ?, is_plus = 1, heard_from = 'reddit' WHERE id = 'p_paid'").run(today);
    person(raw, 'p_old', 'so');
    raw.prepare("UPDATE profiles SET free_month_at = '2026-01-01T00:00:00.000Z', heard_from = 'store' WHERE id = 'p_old'").run();
    const s = (await as('GET', '/v1/admin/free-month')).json;
    expect(s).toMatchObject({ claimed: 3, paying: 1 });
    expect(s.gifted).toBeUndefined();
    expect(s.days).toEqual([{ day: today.slice(0, 10), n: 2 }]);
    expect(s.heard_from).toEqual([
      { heard_from: 'reddit', n: 2 },
      { heard_from: 'store', n: 1 },
    ]);
  });
});
