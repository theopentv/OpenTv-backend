import { describe, expect, it } from 'vitest';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';
import type { Env } from '@/env';

/**
 * Lists two people build together — the one place this server holds the truth
 * rather than mirroring a phone.
 *
 * What is worth pinning: that JOINING is never paid, that a non-member cannot
 * learn a list exists, that the invite code belongs to the owner alone, and
 * that nobody can tick something off on somebody else's behalf.
 */

async function world(): Promise<{
  env: Env;
  raw: ReturnType<typeof freshDatabase>['raw'];
  owner: string;
  friend: string;
  stranger: string;
}> {
  const { raw, db } = freshDatabase();
  insertProfile(raw, 'p_owner', 'owner');
  insertProfile(raw, 'p_friend', 'friend');
  insertProfile(raw, 'p_stranger', 'stranger');
  const env = makeEnv(db);
  return {
    env,
    raw,
    owner: await tokenFor(env, 'p_owner'),
    friend: await tokenFor(env, 'p_friend'),
    stranger: await tokenFor(env, 'p_stranger'),
  };
}

async function makeList(env: Env, token: string, name = 'Sunday films') {
  const res = await call(env, 'POST', '/v1/shared-lists', { token, body: { name } });
  return res.json as { id: string; invite_code: string };
}

describe('starting a list', () => {
  it('makes the starter a member, as the owner', async () => {
    const { env, owner } = await world();
    const { id } = await makeList(env, owner);
    const mine = await call(env, 'GET', '/v1/shared-lists', { token: owner });
    expect(mine.json.lists).toHaveLength(1);
    expect(mine.json.lists[0]).toMatchObject({ id, is_owner: true, members: 1, items: 0 });
  });

  it('needs Plus for a SECOND one, and not for the first', async () => {
    const { env, owner } = await world();
    const first = await call(env, 'POST', '/v1/shared-lists', { token: owner, body: { name: 'One' } });
    expect(first.status).toBe(200);
    const second = await call(env, 'POST', '/v1/shared-lists', { token: owner, body: { name: 'Two' } });
    expect(second.status).toBe(403);
    expect(second.json.error.code).toBe('plus_required');
  });

  it('Plus starts as many as it likes', async () => {
    const { env, raw, owner } = await world();
    raw.prepare("UPDATE profiles SET is_plus = 1 WHERE id = 'p_owner'").run();
    for (const name of ['One', 'Two', 'Three']) {
      expect((await call(env, 'POST', '/v1/shared-lists', { token: owner, body: { name } })).status).toBe(200);
    }
  });

  /*
   * DELETING DOES NOT REFUND A LIST SOMEBODY JOINED (2.4.0). Otherwise the
   * free one is a free subscription: start, share, delete, start again.
   */
  it('deleting a list nobody joined gives the free one back', async () => {
    const { env, owner } = await world();
    const { id } = await makeList(env, owner);
    await call(env, 'DELETE', `/v1/shared-lists/${id}`, { token: owner });
    expect((await call(env, 'POST', '/v1/shared-lists', { token: owner, body: { name: 'Again' } })).status).toBe(200);
  });

  it('deleting a list somebody joined does not', async () => {
    const { env, owner, friend } = await world();
    const { id, invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    await call(env, 'DELETE', `/v1/shared-lists/${id}`, { token: owner });
    const again = await call(env, 'POST', '/v1/shared-lists', { token: owner, body: { name: 'Again' } });
    expect(again.status).toBe(403);
    expect(again.json.error.code).toBe('plus_required');
  });

  it('a friend joining and leaving again still counts it as shared', async () => {
    const { env, raw, owner, friend } = await world();
    const { id, invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    await call(env, 'DELETE', `/v1/shared-lists/${id}`, { token: friend });
    expect(raw.prepare('SELECT was_shared FROM shared_lists WHERE id = ?').get(id)).toEqual({ was_shared: 1 });
    await call(env, 'DELETE', `/v1/shared-lists/${id}`, { token: owner });
    expect((await call(env, 'POST', '/v1/shared-lists', { token: owner, body: { name: 'Again' } })).json.error.code).toBe(
      'plus_required',
    );
  });

  it('counts only lists you STARTED, never ones you were invited to', async () => {
    const { env, raw, owner, friend } = await world();
    const { invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    // The friend is in a list and has started none, so their first is still free.
    const theirs = await call(env, 'POST', '/v1/shared-lists', { token: friend, body: { name: 'Mine' } });
    expect(theirs.status).toBe(200);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM shared_lists').get()).toMatchObject({ n: 2 });
  });
});

describe('joining', () => {
  it('is free, for ever, at any tier', async () => {
    // The whole design: a list whose invitees must pay to accept is a list of
    // one person, and the member who paid has bought an empty room.
    const { env, owner, friend, stranger } = await world();
    const { invite_code } = await makeList(env, owner);
    for (const token of [friend, stranger]) {
      const res = await call(env, 'POST', '/v1/shared-lists/join', { token, body: { invite_code } });
      expect(res.status).toBe(200);
      expect(res.json.joined).toBe(true);
    }
  });

  it('is idempotent — a link tapped twice lands you in the list, not on an error', async () => {
    const { env, owner, friend } = await world();
    const { invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    const again = await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    expect(again.status).toBe(200);
    expect(again.json.joined).toBe(false);
  });

  it('refuses a code nobody issued', async () => {
    const { env, friend } = await world();
    const res = await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code: 'NOPE' } });
    expect(res.status).toBe(404);
  });
});

describe('reading a list', () => {
  it('lets a non-member read it, because it is on its members\' profiles', async () => {
    /*
     * This asserted a 404 while an invite code was the only way to learn a list
     * existed. Now the list is printed on every member's public profile, so
     * refusing to open it would only mean the profile advertises doors that do
     * not open. Read is open; joining, adding and ticking still are not.
     */
    const { env, owner, stranger } = await world();
    const { id } = await makeList(env, owner);
    const res = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: stranger });
    expect(res.status).toBe(200);
    expect(res.json.is_member).toBe(false);
    // the key to PARTICIPATING is still the owner's alone
    expect(res.json.invite_code).toBe(null);
    // and how far each member has got stays between the members
    expect(res.json.members.every((m: { watched: number }) => m.watched === 0)).toBe(true);
  });

  it('still refuses a non-member every way IN', async () => {
    // Read opened; write did not. This is the half that keeps the code meaning
    // something now that it no longer guards knowing the list exists.
    const { env, owner, stranger } = await world();
    const { id } = await makeList(env, owner);
    const add = await call(env, 'POST', `/v1/shared-lists/${id}/items`, {
      token: stranger,
      body: { source: 'tvdb', key: '1', title: 'X', poster: null },
    });
    expect(add.status).toBe(404);
  });;

  it('gives the invite code to the owner and to nobody else', async () => {
    const { env, owner, friend } = await world();
    const { id, invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });

    const asOwner = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: owner });
    const asMember = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: friend });
    expect(asOwner.json.invite_code).toBe(invite_code);
    expect(asMember.json.invite_code).toBeNull();
    expect(asMember.json.is_owner).toBe(false);
  });
});

describe('items', () => {
  it('lets any member add, and says who did', async () => {
    const { env, owner, friend } = await world();
    const { id, invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });

    const added = await call(env, 'POST', `/v1/shared-lists/${id}/items`, {
      token: friend,
      body: { target_source: 'movie', target_key: 'heat|1995', title: 'Heat', poster: null },
    });
    expect(added.json.added).toBe(true);

    const detail = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: owner });
    expect(detail.json.items).toHaveLength(1);
    // "Sara added this" is the whole reason anybody opens the app on a Tuesday.
    expect(detail.json.items[0].added_by).toBe('p_friend');
  });

  it('does not turn two people adding the same film into an error', async () => {
    const { env, owner, friend } = await world();
    const { id, invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    const body = { target_source: 'movie', target_key: 'heat|1995', title: 'Heat', poster: null };
    const a = await call(env, 'POST', `/v1/shared-lists/${id}/items`, { token: owner, body });
    const b = await call(env, 'POST', `/v1/shared-lists/${id}/items`, { token: friend, body });
    expect(a.json.added).toBe(true);
    expect(b.status).toBe(200);
    expect(b.json.added).toBe(false);
  });

  it('lets you remove your own, and the owner remove anything', async () => {
    const { env, owner, friend } = await world();
    const { id, invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    await call(env, 'POST', `/v1/shared-lists/${id}/items`, {
      token: friend,
      body: { target_source: 'movie', target_key: 'a', title: 'A', poster: null },
    });
    const detail = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: owner });
    const itemId = detail.json.items[0].id;

    const byOwner = await call(env, 'DELETE', `/v1/shared-lists/${id}/items/${itemId}`, { token: owner });
    expect(byOwner.status).toBe(200);
  });

  it('will not let one member delete another member’s suggestion', async () => {
    const { env, owner, friend, stranger } = await world();
    const { id, invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    await call(env, 'POST', '/v1/shared-lists/join', { token: stranger, body: { invite_code } });
    await call(env, 'POST', `/v1/shared-lists/${id}/items`, {
      token: friend,
      body: { target_source: 'movie', target_key: 'a', title: 'A', poster: null },
    });
    const detail = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: friend });
    const itemId = detail.json.items[0].id;
    const res = await call(env, 'DELETE', `/v1/shared-lists/${id}/items/${itemId}`, { token: stranger });
    expect(res.status).toBe(403);
  });
});

describe('ticking things off', () => {
  it('is per member — one of us having seen it is not both of us', async () => {
    const { env, owner, friend } = await world();
    const { id, invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    await call(env, 'POST', `/v1/shared-lists/${id}/items`, {
      token: owner,
      body: { target_source: 'movie', target_key: 'a', title: 'A', poster: null },
    });
    const detail = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: owner });
    const itemId = detail.json.items[0].id;

    await call(env, 'POST', `/v1/shared-lists/${id}/items/${itemId}/watched`, { token: friend });
    const after = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: owner });
    expect(after.json.items[0].watched_by).toEqual(['p_friend']);
    expect(after.json.members.find((m: { id: string }) => m.id === 'p_friend').watched).toBe(1);
    expect(after.json.members.find((m: { id: string }) => m.id === 'p_owner').watched).toBe(0);
  });

  it('unticks only your own — nobody answers "have you seen this" for anybody else', async () => {
    const { env, owner, friend } = await world();
    const { id, invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    await call(env, 'POST', `/v1/shared-lists/${id}/items`, {
      token: owner,
      body: { target_source: 'movie', target_key: 'a', title: 'A', poster: null },
    });
    const d1 = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: owner });
    const itemId = d1.json.items[0].id;
    await call(env, 'POST', `/v1/shared-lists/${id}/items/${itemId}/watched`, { token: friend });
    // The owner tries to clear the friend's tick: their own DELETE removes
    // nothing, because there is no route that names another member.
    await call(env, 'DELETE', `/v1/shared-lists/${id}/items/${itemId}/watched`, { token: owner });
    const d2 = await call(env, 'GET', `/v1/shared-lists/${id}`, { token: owner });
    expect(d2.json.items[0].watched_by).toEqual(['p_friend']);
  });
});

describe('renaming, rotating and leaving', () => {
  it('lets the owner rename, and refuses a member', async () => {
    const { env, owner, friend } = await world();
    const { id, invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    expect((await call(env, 'PATCH', `/v1/shared-lists/${id}`, { token: owner, body: { name: 'New' } })).status).toBe(200);
    expect((await call(env, 'PATCH', `/v1/shared-lists/${id}`, { token: friend, body: { name: 'Nope' } })).status).toBe(404);
  });

  it('kills a forwarded invite when the owner rotates it', async () => {
    const { env, owner, stranger } = await world();
    const { id, invite_code } = await makeList(env, owner);
    const rotated = await call(env, 'PATCH', `/v1/shared-lists/${id}`, { token: owner, body: { rotate_invite: true } });
    expect(rotated.json.invite_code).not.toBe(invite_code);
    const old = await call(env, 'POST', '/v1/shared-lists/join', { token: stranger, body: { invite_code } });
    expect(old.status).toBe(404);
  });

  it('takes a member off their own screen without touching the list', async () => {
    const { env, owner, friend } = await world();
    const { id, invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    await call(env, 'DELETE', `/v1/shared-lists/${id}`, { token: friend });
    expect((await call(env, 'GET', '/v1/shared-lists', { token: friend })).json.lists).toEqual([]);
    expect((await call(env, 'GET', '/v1/shared-lists', { token: owner })).json.lists).toHaveLength(1);
  });

  it('removes it from everybody when the OWNER deletes', async () => {
    const { env, owner, friend } = await world();
    const { id, invite_code } = await makeList(env, owner);
    await call(env, 'POST', '/v1/shared-lists/join', { token: friend, body: { invite_code } });
    await call(env, 'DELETE', `/v1/shared-lists/${id}`, { token: owner });
    expect((await call(env, 'GET', '/v1/shared-lists', { token: friend })).json.lists).toEqual([]);
    expect((await call(env, 'GET', `/v1/shared-lists/${id}`, { token: friend })).status).toBe(404);
  });
});

describe('the artwork a shelf needs', () => {
  it('sends posters with the summary, newest first, at most four', async () => {
    /*
     * The summary carried only a COUNT, so every shelf drew a shared list as a
     * black rectangle with a name on it -- "I added films and the cover shows
     * nothing, for anybody".
     */
    const { env, owner } = await world();
    const { id } = await makeList(env, owner);
    for (let n = 1; n <= 6; n++) {
      await call(env, 'POST', `/v1/shared-lists/${id}/items`, {
        token: owner,
        body: { target_source: 'tvdb', target_key: String(n), title: `Show ${n}`, poster: `https://img/${n}.jpg` },
      });
    }
    const mine = await call(env, 'GET', '/v1/shared-lists', { token: owner });
    const row = mine.json.lists[0];
    expect(row.items).toBe(6);
    expect(row.posters).toHaveLength(4);
    // every entry is a real url, never an empty string from a split
    expect(row.posters.every((p: string) => p.startsWith('https://img/'))).toBe(true);
  });

  it('a list with no artwork sends an empty array, not a blank string', async () => {
    const { env, owner } = await world();
    const { id } = await makeList(env, owner);
    await call(env, 'POST', `/v1/shared-lists/${id}/items`, {
      token: owner,
      body: { target_source: 'tvdb', target_key: '1', title: 'No art', poster: null },
    });
    const mine = await call(env, 'GET', '/v1/shared-lists', { token: owner });
    expect(mine.json.lists[0].posters).toEqual([]);
  });
});
