/**
 * Giving somebody Plus from the dashboard.
 *
 * `plus_until` AND NEVER `is_plus`. The flag belongs to the RevenueCat webhook
 * and means "this person is paying". Writing it by hand would make the server
 * believe in a subscription that does not exist, it would be overwritten by the
 * next webhook anyway, and it would put a hand-out into the revenue numbers.
 * The date is the hand-grant lane, and `plusEntitled()` honours both.
 *
 * The one behaviour worth its own test is EXTENDING: a grant added to a live
 * grant has to reach further out, not reset to a month from today. Anything
 * else silently takes time away from the person being given something, which
 * is the opposite of the intent every single time this route is used.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '@/env';
import { call, freshDatabase, makeEnv } from './harness';

let raw: Database.Database;
let env: Env;
let cookie: string;

function profile(id: string, plusUntil: string | null = null, isPlus = 0): void {
  raw
    .prepare(
      'INSERT INTO profiles (id, handle, handle_lower, created_at, plus_until, is_plus) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, id, id, '2026-08-01T00:00:00.000Z', plusUntil, isPlus);
}

const read = (h: string) =>
  raw.prepare('SELECT plus_until AS until, is_plus AS flag FROM profiles WHERE handle_lower = ?').get(h) as {
    until: string | null;
    flag: number;
  };

const give = (handle: string, months: number) =>
  call(env, 'POST', `/v1/admin/users/${handle}/plus`, { body: { months }, headers: { Cookie: cookie } });

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = { ...makeEnv(fresh.db), ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' } as Env;
  const res = await call(env, 'POST', '/v1/admin/login', {
    body: { email: 'me@example.com', password: 'a-long-one' },
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

describe('POST /v1/admin/users/:handle/plus', () => {
  it('refuses without the admin cookie', async () => {
    profile('amanda');
    const res = await call(env, 'POST', '/v1/admin/users/amanda/plus', { body: { months: 1 } });
    expect(res.status).toBe(401);
    expect(read('amanda').until).toBeNull();
  });

  it('gives a month, and does not touch the paying flag', async () => {
    profile('amanda');
    const res = await give('amanda', 1);
    expect(res.status).toBe(200);
    const row = read('amanda');
    expect(row.until).not.toBeNull();
    // The webhook owns this. A gift must never look like revenue.
    expect(row.flag).toBe(0);
    expect(Date.parse(row.until as string)).toBeGreaterThan(Date.now());
  });

  it('EXTENDS a live grant instead of resetting it', async () => {
    // Three weeks left plus one month should be about seven weeks, not four.
    const threeWeeks = new Date(Date.now() + 21 * 86400000).toISOString();
    profile('amanda', threeWeeks);
    await give('amanda', 1);
    const days = (Date.parse(read('amanda').until as string) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(45);
  });

  it('starts from today when the old grant has already expired', async () => {
    // Otherwise "one month" would be measured from a date in the past and the
    // person would be given something that is already over.
    profile('amanda', '2020-01-01T00:00:00.000Z');
    await give('amanda', 1);
    const days = (Date.parse(read('amanda').until as string) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(33);
  });

  it('gives a year', async () => {
    profile('amanda');
    await give('amanda', 12);
    const days = (Date.parse(read('amanda').until as string) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(360);
  });

  it('removes the grant on months = 0', async () => {
    profile('amanda', new Date(Date.now() + 86400000).toISOString());
    const res = await give('amanda', 0);
    expect(res.status).toBe(200);
    expect(read('amanda').until).toBeNull();
  });

  it('leaves a paying subscriber’s flag alone when removing a grant', async () => {
    // Somebody who was given a month AND then subscribed properly must keep
    // their subscription when the gift is cleared.
    profile('amanda', new Date(Date.now() + 86400000).toISOString(), 1);
    await give('amanda', 0);
    const row = read('amanda');
    expect(row.until).toBeNull();
    expect(row.flag).toBe(1);
  });

  it('refuses nonsense month counts rather than writing a strange date', async () => {
    profile('amanda');
    for (const bad of [-1, 13, 1.5, 'two', null]) {
      const res = await call(env, 'POST', '/v1/admin/users/amanda/plus', {
        body: { months: bad },
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(400);
    }
    expect(read('amanda').until).toBeNull();
  });

  it('404s for a handle that does not exist', async () => {
    const res = await give('nobody', 1);
    expect(res.status).toBe(404);
  });

  it('ignores a deleted profile', async () => {
    profile('amanda');
    raw.prepare("UPDATE profiles SET deleted_at = ? WHERE handle_lower = 'amanda'").run('2026-08-30T00:00:00.000Z');
    const res = await give('amanda', 1);
    expect(res.status).toBe(404);
  });
});

/**
 * A PAYING SUBSCRIBER'S GIFT GOES TO THE STORE. RevenueCat is stubbed: the
 * first call is the customer lookup, the second is /extend (Apple) or /defer
 * (Google). A non-paying profile never reaches RevenueCat at all.
 */
describe('POST /v1/admin/users/:handle/plus for a paying subscriber', () => {
  const calls: { url: string; body?: string }[] = [];
  const customer = (store: string, product: string) => ({
    subscriber: {
      entitlements: { plus: { expires_date: '2099-01-01T00:00:00Z', product_identifier: product } },
      subscriptions: { [product]: { store, store_transaction_id: 1000000652379790, expires_date: '2099-01-01T00:00:00Z' } },
    },
  });
  const stub = (lookup: unknown, write: { status: number; body: unknown }) => {
    calls.length = 0;
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body });
      const r = init?.body ? write : { status: 200, body: lookup };
      return new Response(JSON.stringify(r.body), { status: r.status });
    });
  };
  const after = { subscriber: { entitlements: { plus: { expires_date: '2099-01-31T00:00:00Z' } } } };

  beforeEach(() => {
    env = { ...env, RC_SECRET_API_KEY: 'sk_test' } as Env;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('extends at Apple by transaction id and leaves plus_until alone', async () => {
    profile('amanda', null, 1);
    stub(customer('app_store', 'com.insightfy.opentv.plus.monthly'), { status: 200, body: after });
    const res = await give('amanda', 1);
    expect(res.status).toBe(200);
    expect((res.json as { via: string }).via).toBe('app_store');
    expect(calls[1]?.url).toContain('/subscriptions/1000000652379790/extend');
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ extend_by_days: 30, extend_reason_code: 1 });
    expect(read('amanda').until).toBeNull();
    const exp = raw.prepare("SELECT plus_expires_at AS e FROM profiles WHERE id = 'amanda'").get() as { e: string };
    expect(exp.e).toBe('2099-01-31T00:00:00Z');
  });

  it('defers at Google by the subscription id before the colon', async () => {
    profile('amanda', null, 1);
    stub(customer('play_store', 'opentv_plus:monthly'), { status: 200, body: after });
    const res = await give('amanda', 2);
    expect(res.status).toBe(200);
    expect(calls[1]?.url).toMatch(/\/subscriptions\/opentv_plus\/defer$/);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ extend_by_days: 60 });
  });

  it('refuses more than 90 days at Apple without calling it', async () => {
    profile('amanda', null, 1);
    stub(customer('app_store', 'com.insightfy.opentv.plus.yearly'), { status: 200, body: after });
    const res = await give('amanda', 6);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('passes on RevenueCat’s refusal instead of pretending', async () => {
    profile('amanda', null, 1);
    stub(customer('app_store', 'm'), { status: 400, body: { message: 'Only two extensions per year' } });
    const res = await give('amanda', 1);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.json)).toContain('two extensions');
    expect(read('amanda').until).toBeNull();
  });

  it('falls back to plus_until for a promotional grant', async () => {
    profile('amanda', null, 1);
    stub(customer('promotional', 'rc_promo_plus'), { status: 200, body: after });
    await give('amanda', 1);
    expect(read('amanda').until).not.toBeNull();
  });

  it('never asks RevenueCat about somebody who is not paying', async () => {
    profile('amanda');
    stub({}, { status: 200, body: {} });
    await give('amanda', 1);
    expect(calls).toHaveLength(0);
    expect(read('amanda').until).not.toBeNull();
  });
});
