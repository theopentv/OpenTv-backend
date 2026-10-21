import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { tvtimeCommentId } from '@/pure';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * TV Time REPLIES, imported as replies (migration 0062).
 *
 * The export links a reply to the comment it answers, and that comment is
 * usually somebody else's — so it reaches this server only when THAT person
 * imports. Pinned here: a parent already present is found, a reply that arrives
 * first is adopted later, a re-seed backfills rows seeded before the ids
 * existed, and a reply with no original is flagged in the thread read.
 */

let raw: ReturnType<typeof freshDatabase>['raw'];
let env: Env;
let alice: string;
let bob: string;

const ON = { target_source: 'tvdb', target_key: '349271', season: 4, episode: 20 };
const THREAD = '/v1/comments?source=tvdb&key=349271&season=4&episode=20';

const ROOT = { ...ON, body: 'What an ending.', created_at: '2022-06-10T20:00:00.000Z', tvtime_id: 'e:100' };
const REPLY = {
  ...ON,
  body: '@alice É isso…',
  created_at: '2022-06-10T21:00:00.000Z',
  tvtime_id: 'e:101',
  tvtime_parent_id: 'e:100',
};

const imp = (token: string, items: unknown[]) => call(env, 'POST', '/v1/comments/import', { token, body: { items } });
const parentOf = (body: string) =>
  (raw.prepare('SELECT parent_id FROM comments WHERE body = ?').get(body) as { parent_id: string | null }).parent_id;
const idOf = (body: string) => (raw.prepare('SELECT id FROM comments WHERE body = ?').get(body) as { id: string }).id;

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p_alice', 'alice');
  insertProfile(raw, 'p_bob', 'bob');
  alice = await tokenFor(env, 'p_alice');
  bob = await tokenFor(env, 'p_bob');
});

describe('importing TV Time replies', () => {
  it('hangs a reply under its parent when the parent is already here', async () => {
    await imp(alice, [ROOT]);
    const res = await imp(bob, [REPLY]);
    expect(res.json.imported).toBe(1);
    expect(parentOf(REPLY.body)).toBe(idOf(ROOT.body));

    const top = (await call(env, 'GET', THREAD)).json.items;
    expect(top.map((c: { body: string }) => c.body)).toEqual([ROOT.body]);
    expect(top[0].reply_count).toBe(1);
    expect(top[0].orphan_reply).toBe(false);
  });

  it('flags a reply whose original is not here, then ADOPTS it when the original arrives', async () => {
    await imp(bob, [REPLY]);
    const before = (await call(env, 'GET', THREAD)).json.items;
    expect(before).toHaveLength(1);
    expect(before[0].orphan_reply).toBe(true);

    await imp(alice, [ROOT]);
    expect(parentOf(REPLY.body)).toBe(idOf(ROOT.body));
    const after = (await call(env, 'GET', THREAD)).json.items;
    expect(after.map((c: { body: string }) => c.body)).toEqual([ROOT.body]);
    expect(after[0].reply_count).toBe(1);
  });

  it('a re-seed backfills a row seeded before the ids existed, without counting it as imported', async () => {
    const { tvtime_id: _a, ...oldRoot } = ROOT;
    const { tvtime_id: _b, tvtime_parent_id: _c, ...oldReply } = REPLY;
    await imp(alice, [oldRoot]);
    await imp(bob, [oldReply]);
    expect(parentOf(REPLY.body)).toBe(null); // the bug: a reply standing as a post

    expect((await imp(bob, [REPLY])).json.imported).toBe(0);
    // still orphan: alice's row has no tvtime id yet
    expect((await call(env, 'GET', THREAD)).json.items.find((c: { body: string }) => c.body === REPLY.body).orphan_reply).toBe(true);

    expect((await imp(alice, [ROOT])).json.imported).toBe(0);
    expect(parentOf(REPLY.body)).toBe(idOf(ROOT.body));
    // idempotent
    await imp(alice, [ROOT]);
    await imp(bob, [REPLY]);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 2 });
  });

  it('never attaches across threads, and keeps replies one level deep', async () => {
    // same TV Time id, another episode: not its parent
    await imp(alice, [{ ...ROOT, episode: 21, body: 'elsewhere' }]);
    await imp(bob, [REPLY]);
    expect(parentOf(REPLY.body)).toBe(null);

    // a reply to the reply hangs off the root
    const deeper = { ...ON, body: 'and again', created_at: '2022-06-11T00:00:00.000Z', tvtime_id: 'e:102', tvtime_parent_id: 'e:101' };
    await imp(alice, [deeper]); // arrives before root: attaches to the orphan reply
    await imp(alice, [ROOT]); // root arrives: reply adopted, its child flattened onto root
    expect(parentOf(REPLY.body)).toBe(idOf(ROOT.body));
    expect(parentOf('and again')).toBe(idOf(ROOT.body));
  });

  it('keeps the two TV Time id spaces apart and drops anything else', () => {
    expect(tvtimeCommentId('e:28320931')).toBe('e:28320931');
    expect(tvtimeCommentId('c:c66a4d87-9c41-44ab-834d-7d172b1f3970')).toBe('c:c66a4d87-9c41-44ab-834d-7d172b1f3970');
    expect(tvtimeCommentId('28320931')).toBe(null);
    expect(tvtimeCommentId("e:1' OR 1")).toBe(null);
    expect(tvtimeCommentId(5)).toBe(null);
  });

  it('a reply is not one of its author’s posts on the profile, orphan or not', async () => {
    await imp(bob, [REPLY, { ...ON, body: 'my own post', created_at: '2022-01-01T00:00:00.000Z' }]);
    const feed = (await call(env, 'GET', '/v1/profiles/bob/comments')).json.items;
    expect(feed.map((c: { body: string }) => c.body)).toEqual(['my own post']);
    expect((await call(env, 'GET', '/v1/profiles/bob')).json.comments ?? (await call(env, 'GET', '/v1/profiles/bob')).json.counts?.comments).toBe(1);
  });

  it('deleting the original’s account sends the imported replies back to waiting, not with it', async () => {
    await imp(alice, [ROOT]);
    await imp(bob, [REPLY]);
    expect((await call(env, 'DELETE', '/v1/me', { token: alice })).status).toBeLessThan(300);
    expect(parentOf(REPLY.body)).toBe(null);
    expect((await call(env, 'GET', THREAD)).json.items[0].orphan_reply).toBe(true);
  });
});
