import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

let raw: Database.Database;
let env: Env;
let token: string;
const day = new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p1', 'mahmood');
  token = await tokenFor(env, 'p1');
});

const post = (body: Record<string, unknown>) => call(env, 'POST', '/v1/puzzle/played', { token, body });
const rows = () => raw.prepare('SELECT * FROM puzzle_days').all() as Record<string, unknown>[];

describe('POST /v1/puzzle/played', () => {
  it('keeps how it went, and the first write of a day wins', async () => {
    expect((await post({ day, won: true, tries: 3, streak: 5 })).status).toBe(200);
    await post({ day, won: false, tries: 6, streak: 9 });
    expect(rows()).toEqual([{ profile_id: 'p1', day, won: 1, tries: 3, streak: 5 }]);
  });
  it('ignores anything that is not the shape, so a title cannot get in', async () => {
    await post({ day, won: true, tries: 3, streak: 5, title: 'Saving Hope' });
    expect(Object.keys(rows()[0]!)).toEqual(['profile_id', 'day', 'won', 'tries', 'streak']);
  });
  it('refuses a far day, a bad result, and nobody', async () => {
    expect((await post({ day: '2020-01-01', won: true, tries: 3, streak: 1 })).status).toBe(400);
    expect((await post({ day, won: 'yes', tries: 3, streak: 1 })).status).toBe(400);
    expect((await call(env, 'POST', '/v1/puzzle/played', { body: { day, won: true, tries: 1, streak: 1 } })).status).toBe(401);
    expect(rows()).toEqual([]);
  });
});

describe('make-up days', () => {
  it('a granted far day can be played later and its result replaces the grant; others stay refused', async () => {
    const old = '2026-09-01';
    raw.prepare("INSERT INTO puzzle_days VALUES ('p1', ?, 0, -2, 0)").run(old);
    expect((await post({ day: old, won: true, tries: 2, streak: 5 })).status).toBe(200);
    expect(rows().find((r) => r.day === old)).toMatchObject({ won: 1, tries: 2 });
    expect((await post({ day: '2026-09-02', won: true, tries: 2, streak: 5 })).status).toBe(400);
    // a real day is still first-write-wins
    await post({ day, won: true, tries: 3, streak: 1 });
    await post({ day, won: false, tries: 6, streak: 1 });
    expect(rows().find((r) => r.day === day)).toMatchObject({ won: 1, tries: 3 });
  });
});

describe('GET /v1/puzzle/played', () => {
  it('gives a wiped phone its own days back, and nobody else\'s', async () => {
    await post({ day, won: true, tries: 2, streak: 1 });
    insertProfile(raw, 'p2', 'sara');
    raw.prepare("INSERT INTO puzzle_days VALUES ('p2', ?, 0, 6, 4)").run(day);
    const res = await call(env, 'GET', '/v1/puzzle/played', { token });
    expect(res.json).toEqual({ days: [{ day, won: true, tries: 2 }] });
    expect((await call(env, 'GET', '/v1/puzzle/played')).status).toBe(401);
  });
});

describe('GET /v1/admin/puzzle', () => {
  it('counts live streaks, and a streak left two days ago is not one', async () => {
    const put = raw.prepare('INSERT INTO puzzle_days (profile_id, day, won, tries, streak) VALUES (?, ?, 1, 3, ?)');
    const ago = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
    insertProfile(raw, 'p2', 'sara');
    insertProfile(raw, 'p3', 'gone');
    put.run('p1', ago(1), 8);
    put.run('p1', day, 9);
    put.run('p2', ago(1), 31);
    put.run('p3', ago(3), 50);
    env = { ...env, ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' };
    const login = await call(env, 'POST', '/v1/admin/login', { body: { email: 'me@example.com', password: 'a-long-one' } });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const res = await call(env, 'GET', '/v1/admin/puzzle', { headers: { Cookie: cookie } });
    expect(res.json).toMatchObject({ today: 1, playing: 2, longest: 31, week: 2, month: 1, players: 3 });
  });
  it('is the dashboard\'s alone', async () => {
    expect((await call(env, 'GET', '/v1/admin/puzzle')).status).toBe(401);
  });
});
