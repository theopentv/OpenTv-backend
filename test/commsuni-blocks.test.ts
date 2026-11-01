import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { trimComment } from '@/routes/commsuni';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

let raw: Database.Database;
let env: Env;
let token: string;

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  token = await tokenFor(env, 'p1');
});

const list = async (t = token) => (await call(env, 'GET', '/v1/commsuni/blocks', { token: t })).json as { blocks: { id: string; name: string | null }[] };

describe('CommsUni Block author (§A11.4)', () => {
  it('blocks, lists and unblocks, once per author', async () => {
    expect((await call(env, 'POST', '/v1/commsuni/blocks', { token, body: { id: 'auth-1', name: 'Quiet Otter' } })).status).toBe(200);
    await call(env, 'POST', '/v1/commsuni/blocks', { token, body: { id: 'auth-1', name: 'Quiet Otter' } });
    expect((await list()).blocks).toEqual([expect.objectContaining({ id: 'auth-1', name: 'Quiet Otter' })]);
    expect((await call(env, 'DELETE', '/v1/commsuni/blocks/auth-1', { token })).status).toBe(200);
    expect((await list()).blocks).toEqual([]);
  });
  it('is one member\'s own list', async () => {
    await call(env, 'POST', '/v1/commsuni/blocks', { token, body: { id: 'auth-1' } });
    expect((await list(await tokenFor(env, 'p2'))).blocks).toEqual([]);
  });
  it('refuses a bad id and nobody', async () => {
    expect((await call(env, 'POST', '/v1/commsuni/blocks', { token, body: { id: 'a b/c' } })).status).toBe(400);
    expect((await call(env, 'POST', '/v1/commsuni/blocks', { body: { id: 'auth-1' } })).status).toBe(401);
  });
  it('hands the phone the author id it blocks by', () => {
    const c = trimComment({ id: 'c1', text: 'hi', userId: 'auth-9', userName: 'Quiet Otter' });
    expect(c?.author.id).toBe('auth-9');
  });
});
