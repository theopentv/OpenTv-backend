import { describe, expect, it } from 'vitest';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';
import type { Env } from '@/env';

/**
 * Watching together (2.0.0, design §2) — a shared list of one show whose tick
 * became a position.
 *
 * What is worth pinning: that STARTING always needs Plus and joining never
 * does, that a lapse freezes nothing already running (D11), that five is the
 * ceiling (D9), that the server holds one overwritten cursor per member and
 * nothing more, that a visitor never sees it, and that it goes with the pair.
 */

const SHOW = { target_source: 'tvdb', target_key: '121361', title: 'Game of Thrones', poster: 'https://x/p.jpg' };

async function world() {
  const { raw, db } = freshDatabase();
  for (const h of ['owner', 'friend', 'stranger', 'a', 'b', 'c', 'd']) insertProfile(raw, `p_${h}`, h);
  raw.prepare("UPDATE profiles SET is_plus = 1 WHERE id = 'p_owner'").run();
  const env = makeEnv(db);
  const t = async (h: string) => tokenFor(env, `p_${h}`);
  return { env, raw, t, owner: await t('owner'), friend: await t('friend'), stranger: await t('stranger') };
}

async function startTogether(env: Env, token: string) {
  const res = await call(env, 'POST', '/v1/shared-lists', { token, body: { kind: 'together', item: SHOW } });
  expect(res.status).toBe(200);
  const { id, invite_code } = res.json as { id: string; invite_code: string };
  const detail = await call(env, 'GET', `/v1/shared-lists/${id}`, { token });
  return { id, invite_code, itemId: detail.json.items[0].id as string };
}

const put = (env: Env, token: string, id: string, itemId: string, body: unknown) =>
  call(env, 'PUT', `/v1/shared-lists/${id}/items/${itemId}/position`, { token, body });

describe('starting a together', () => {
  it('needs Plus EVERY time — there is no free first one', async () => {
    const { env, friend } = await world();
    const res = await call(env, 'POST', '/v1/shared-lists', { token: friend, body: { kind: 'together', item: SHOW } });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('plus_required');
  });

  it('creates the list, the owner and its one show in one go, named after the show', async () => {
    const { env, owner } = await world();
    const { id } = await startTogether(env, owner);
    const index = await call(env, 'GET', '/v1/shared-lists', { token: owner });
    expect(index.json.lists[0]).toMatchObject({ id, kind: 'together', name: 'Game of Thrones', members: 1, items: 1, show: SHOW });
  });

  it('refuses a film, or no show at all', async () => {
    const { env, owner } = await world();
    for (const item of [undefined, { ...SHOW, target_source: 'movie' }, { ...SHOW, target_key: ' ' }]) {
      const res = await call(env, 'POST', '/v1/shared-lists', { token: owner, body: { kind: 'together', item } });
      expect(res.status).toBe(400);
    }
  });

  it('does not use up the free ordinary list', async () => {
    const { env, raw, owner } = await world();
    await startTogether(env, owner);
    raw.prepare("UPDATE profiles SET is_plus = 0 WHERE id = 'p_owner'").run();
    const res = await call(env, 'POST', '/v1/shared-lists', { token: owner, body: { name: 'Sunday films' } });
    expect(res.status).toBe(200);
    const index = await call(env, 'GET', '/v1/shared-lists', { token: owner });
    expect(index.json.lists.find((l: { id: string }) => l.id === res.json.id)).toMatchObject({ kind: 'list', show: null });
  });

  it('holds exactly one show — adding or removing an item is refused', async () => {
    const { env, owner } = await world();
    const { id, itemId } = await startTogether(env, owner);
    const add = await call(env, 'POST', `/v1/shared-lists/${id}/items`, { token: owner, body: { target_source: 'tvdb', target_key: '1' } });
    expect(add.status).toBe(403);
    const del = await call(env, 'DELETE', `/v1/shared-lists/${id}/items/${itemId}`, { token: owner });
    expect(del.status).toBe(403);
  });
});

describe('joining a together', () => {
  it('is free, and stops at five people', async () => {
    const { env, t, owner } = await world();
    const { invite_code } = await startTogether(env, owner);
    for (const h of ['friend', 'a', 'b', 'c']) {
      const res = await call(env, 'POST', '/v1/shared-lists/join', { token: await t(h), body: { invite_code } });
      expect(res.json).toMatchObject({ kind: 'together', joined: true });
    }
    const sixth = await call(env, 'POST', '/v1/shared-lists/join', { token: await t('d'), body: { invite_code } });
    expect(sixth.status).toBe(403);
    // Its own code: as `forbidden` the app read it as a rejected sign-in.
    expect(sixth.json).toMatchObject({ error: { code: 'list_full' } });
  });
});

describe('positions', () => {
  it('a member writes their own cursor, overwritten, and it may go down', async () => {
    const { env, raw, owner, friend } = await world();
    const { id, invite_code, itemId } = await startTogether(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    expect((await put(env, friend, id, itemId, { season: 2, episode: 4 })).json).toEqual({ ok: true });
    expect((await put(env, friend, id, itemId, { season: 2, episode: 3 })).status).toBe(200);
    // One row, the latest: a cursor, never a history.
    expect(raw.prepare('SELECT season, episode FROM shared_list_positions').all()).toEqual([{ season: 2, episode: 3 }]);
    const detail = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: owner });
    expect(detail.json.kind).toBe('together');
    expect(detail.json.items[0].positions).toMatchObject([{ member_id: 'p_friend', season: 2, episode: 3 }]);
  });

  it('DELETE clears only the caller’s row', async () => {
    const { env, owner, friend } = await world();
    const { id, invite_code, itemId } = await startTogether(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    await put(env, owner, id, itemId, { season: 1, episode: 1 });
    await put(env, friend, id, itemId, { season: 1, episode: 2 });
    await call(env, 'DELETE', `/v1/shared-lists/${id}/items/${itemId}/position`, { token: friend });
    const detail = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: owner });
    expect(detail.json.items[0].positions.map((p: { member_id: string }) => p.member_id)).toEqual(['p_owner']);
  });

  it('refuses out-of-range or non-integer values', async () => {
    const { env, owner } = await world();
    const { id, itemId } = await startTogether(env, owner);
    for (const body of [{ season: -1, episode: 1 }, { season: 1, episode: 10000 }, { season: 1.5, episode: 1 }, { season: '2', episode: 4 }, {}]) {
      expect((await put(env, owner, id, itemId, body)).status).toBe(400);
    }
  });

  it('refuses a non-member, and any ordinary list', async () => {
    const { env, owner, stranger } = await world();
    const { id, itemId } = await startTogether(env, owner);
    expect((await put(env, stranger, id, itemId, { season: 1, episode: 1 })).status).toBe(404);

    const plain = await call(env, 'POST', '/v1/shared-lists', { token: owner, body: { name: 'Films' } });
    await call(env, 'POST', `/v1/shared-lists/${plain.json.id}/items`, { token: owner, body: { target_source: 'tvdb', target_key: '9' } });
    const plainItem = (await call(env, 'GET', `/v1/shared-lists/${plain.json.id}`, { token: owner })).json.items[0].id;
    expect((await put(env, owner, plain.json.id, plainItem, { season: 1, episode: 1 })).status).toBe(404);
  });

  it('a visitor sees the together and who is in it, never where anybody is', async () => {
    const { env, owner, stranger } = await world();
    const { id, itemId } = await startTogether(env, owner);
    await put(env, owner, id, itemId, { season: 3, episode: 1 });
    const seen = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: stranger });
    expect(seen.status).toBe(200);
    expect(seen.json.is_member).toBe(false);
    expect(seen.json.items[0].positions).toEqual([]);
  });

  it('keep working for everybody after the creator’s Plus lapses (D11)', async () => {
    const { env, raw, owner, friend } = await world();
    const { id, invite_code, itemId } = await startTogether(env, owner);
    raw.prepare("UPDATE profiles SET is_plus = 0 WHERE id = 'p_owner'").run();
    expect((await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } })).status).toBe(200);
    expect((await put(env, owner, id, itemId, { season: 1, episode: 5 })).status).toBe(200);
    expect((await put(env, friend, id, itemId, { season: 1, episode: 2 })).status).toBe(200);
    expect((await call(env, 'GET', `/v1/shared-lists/${id}`, { token: friend })).json.items[0].positions).toHaveLength(2);
    // Only STARTING another needs Plus again.
    const again = await call(env, 'POST', '/v1/shared-lists', { token: owner, body: { kind: 'together', item: SHOW } });
    expect(again.json.error.code).toBe('plus_required');
  });
});

describe('a together ending', () => {
  it('leaving takes the leaver’s position with them, and only theirs', async () => {
    const { env, raw, owner, friend } = await world();
    const { id, invite_code, itemId } = await startTogether(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    await put(env, owner, id, itemId, { season: 1, episode: 1 });
    await put(env, friend, id, itemId, { season: 1, episode: 2 });
    await call(env, 'DELETE', `/v1/shared-lists/${id}`, { token: friend });
    expect(raw.prepare('SELECT member_id FROM shared_list_positions').all()).toEqual([{ member_id: 'p_owner' }]);
  });

  it('the owner deleting it removes every position', async () => {
    const { env, raw, owner, friend } = await world();
    const { id, invite_code, itemId } = await startTogether(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    await put(env, owner, id, itemId, { season: 1, episode: 1 });
    await put(env, friend, id, itemId, { season: 1, episode: 2 });
    await call(env, 'DELETE', `/v1/shared-lists/${id}`, { token: owner });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM shared_list_positions').get()).toEqual({ n: 0 });
    expect((await put(env, friend, id, itemId, { season: 1, episode: 3 })).status).toBe(404);
  });

  it('an account purged cascades its position away', async () => {
    const { env, raw, owner, friend } = await world();
    const { id, invite_code, itemId } = await startTogether(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    await put(env, friend, id, itemId, { season: 1, episode: 2 });
    raw.prepare("DELETE FROM profiles WHERE id = 'p_friend'").run();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM shared_list_positions').get()).toEqual({ n: 0 });
  });
});
