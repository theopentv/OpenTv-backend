/**
 * A personal offer from the dashboard (0061), and the one promise it makes:
 * the countdown's end is real. It never moves later, a running offer is never
 * replaced, and the same offer never comes back for the same person.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '@/env';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

let raw: Database.Database;
let env: Env;
let cookie: string;

const give = (handle: string, body: unknown) =>
  call(env, 'POST', `/v1/admin/users/${handle}/offer`, { body, headers: { Cookie: cookie } });
const mine = async (id: string) =>
  (await call(env, 'GET', '/v1/me/offer', { token: await tokenFor(env, id) })).json as {
    offer: { offer_id: string; ends_at: string } | null;
  };

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = { ...makeEnv(fresh.db), ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' } as Env;
  const res = await call(env, 'POST', '/v1/admin/login', { body: { email: 'me@example.com', password: 'a-long-one' } });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  insertProfile(raw, 'p_amanda', 'amanda');
  insertProfile(raw, 'p_other', 'other');
});

describe('POST /v1/admin/users/:handle/offer', () => {
  it('refuses without the admin cookie', async () => {
    const res = await call(env, 'POST', '/v1/admin/users/amanda/offer', { body: { offer_id: 'x', hours: 48 } });
    expect(res.status).toBe(401);
  });

  it('gives an offer that the person, and only the person, then sees', async () => {
    const res = await give('amanda', { offer_id: 'plus_personal_annual_50', hours: 48, label: 'Black Friday' });
    expect(res.status).toBe(200);
    const hours = (Date.parse((res.json as { ends_at: string }).ends_at) - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThanOrEqual(48);
    const got = await mine('p_amanda');
    expect(got.offer?.offer_id).toBe('plus_personal_annual_50');
    // The dashboard's note never reaches the phone.
    expect(JSON.stringify(got)).not.toContain('Black Friday');
    expect((await mine('p_other')).offer).toBeNull();
  });

  it('refuses a second offer while one runs, so the end never moves', async () => {
    await give('amanda', { offer_id: 'a', hours: 2 });
    const before = (await mine('p_amanda')).offer?.ends_at;
    const res = await give('amanda', { offer_id: 'b', hours: 72 });
    expect(res.status).toBe(409);
    expect((await mine('p_amanda')).offer?.ends_at).toBe(before);
  });

  it('never gives the same offer to the same person twice, even after it ended', async () => {
    await give('amanda', { offer_id: 'a', hours: 2 });
    raw.prepare("UPDATE personal_offers SET ends_at = '2020-01-01T00:00:00.000Z'").run();
    expect((await mine('p_amanda')).offer).toBeNull();
    expect((await give('amanda', { offer_id: 'a', hours: 2 })).status).toBe(409);
    // A different offer is a new decision, and is allowed.
    expect((await give('amanda', { offer_id: 'b', hours: 2 })).status).toBe(200);
  });

  it('hours 0 ends a running offer now', async () => {
    await give('amanda', { offer_id: 'a', hours: 48 });
    const res = await give('amanda', { hours: 0 });
    expect(res.json).toEqual({ ended: 1 });
    expect((await mine('p_amanda')).offer).toBeNull();
  });

  it('refuses nonsense', async () => {
    for (const body of [{ offer_id: 'a', hours: -1 }, { offer_id: 'a', hours: 721 }, { offer_id: 'a', hours: 1.5 }, { offer_id: 'a b', hours: 2 }, { hours: 2 }]) {
      expect((await give('amanda', body)).status).toBe(400);
    }
    expect((await give('nobody', { offer_id: 'a', hours: 2 })).status).toBe(404);
  });
});

describe('the phone', () => {
  it('needs a session to ask', async () => {
    expect((await call(env, 'GET', '/v1/me/offer')).status).toBe(401);
  });

  it('spends the offer once it is used', async () => {
    await give('amanda', { offer_id: 'a', hours: 48 });
    const token = await tokenFor(env, 'p_amanda');
    expect((await call(env, 'POST', '/v1/me/offer/used', { token })).status).toBe(200);
    expect((await mine('p_amanda')).offer).toBeNull();
    // Used is not running, but still blocks the same offer coming back.
    expect((await give('amanda', { offer_id: 'a', hours: 2 })).status).toBe(409);
  });

  it('goes with the account', async () => {
    await give('amanda', { offer_id: 'a', hours: 48 });
    await call(env, 'DELETE', '/v1/me', { token: await tokenFor(env, 'p_amanda') });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM personal_offers').get()).toEqual({ n: 0 });
  });
});
