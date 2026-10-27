import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * Follow requests, and per-section hiding.
 *
 * The two things here that can be wrong while every screen looks right:
 *
 *  1. A PENDING ROW THAT COUNTS. `follows` now holds questions as well as
 *     relationships, so any read that forgot `state = 'accepted'` hands a
 *     stranger the followers, the counts and — through `followed_by_me` — the
 *     whole private half of a profile they only ASKED to see. Every count and
 *     list is pinned here against a pending row.
 *  2. HIDING THAT IS ONLY A PREFERENCE. A section hidden in the payload and
 *     served in the data is hidden from the app and from nobody with curl. Each
 *     section is asserted ABSENT for a stranger and PRESENT for the owner, in
 *     the same test, because either half alone passes for the wrong reason.
 */

let raw: Database.Database;
let env: Env;
/** p1 = mahmood, the owner. p2 = sara, everybody else. */
let owner: string;
let other: string;

const setPrivate = () => raw.prepare("UPDATE profiles SET is_private = 1 WHERE id = 'p1'").run();

const followRow = () =>
  raw.prepare("SELECT state FROM follows WHERE follower_id = 'p2' AND followee_id = 'p1'").get() as
    | { state: string }
    | undefined;

const notifications = (kind: string) =>
  raw.prepare('SELECT * FROM notifications WHERE kind = ?').all(kind) as {
    recipient_id: string;
    actor_id: string;
  }[];

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  owner = await tokenFor(env, 'p1');
  other = await tokenFor(env, 'p2');
});

// ── follow requests ─────────────────────────────────────────────────────────

describe('POST /v1/follows/:id — request or follow, depending on the target', () => {
  it('follows a PUBLIC profile outright', async () => {
    const res = await call(env, 'POST', '/v1/follows/p1', { token: other });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, following: true, requested: false });
    expect(followRow()?.state).toBe('accepted');
    expect(notifications('follow')).toHaveLength(1);
    expect(notifications('follow_request')).toHaveLength(0);
  });

  it('only REQUESTS a private profile, and grants nothing meanwhile', async () => {
    setPrivate();
    const res = await call(env, 'POST', '/v1/follows/p1', { token: other });
    expect(res.json).toEqual({ ok: true, following: false, requested: true });
    expect(followRow()?.state).toBe('pending');

    // The question is announced; the follow is not.
    expect(notifications('follow_request')).toEqual([
      expect.objectContaining({ recipient_id: 'p1', actor_id: 'p2' }),
    ]);
    expect(notifications('follow')).toHaveLength(0);

    // And the private half stays shut — this is the assertion that a forgotten
    // `state` filter on `followed_by_me` would fail.
    expect((await call(env, 'GET', '/v1/profiles/mahmood/published', { token: other })).status).toBe(403);
    expect((await call(env, 'GET', '/v1/profiles/mahmood/followers', { token: other })).status).toBe(403);
  });

  it('is idempotent both ways, and a re-tap never re-notifies', async () => {
    setPrivate();
    await call(env, 'POST', '/v1/follows/p1', { token: other });
    const again = await call(env, 'POST', '/v1/follows/p1', { token: other });
    expect(again.json).toEqual({ ok: true, following: false, requested: true });
    expect(notifications('follow_request')).toHaveLength(1);

    raw.prepare("UPDATE follows SET state = 'accepted'").run();
    raw.prepare("UPDATE profiles SET is_private = 0 WHERE id = 'p1'").run();
    const third = await call(env, 'POST', '/v1/follows/p1', { token: other });
    expect(third.json).toEqual({ ok: true, following: true, requested: false });
    expect(notifications('follow')).toHaveLength(0);
  });

  it('turns a pending request into a follow when the profile goes public', async () => {
    setPrivate();
    await call(env, 'POST', '/v1/follows/p1', { token: other });
    raw.prepare("UPDATE profiles SET is_private = 0 WHERE id = 'p1'").run();

    const res = await call(env, 'POST', '/v1/follows/p1', { token: other });
    expect(res.json).toEqual({ ok: true, following: true, requested: false });
    expect(followRow()?.state).toBe('accepted');
    expect(notifications('follow')).toHaveLength(1);
  });

  it('does NOT demote an existing follower when the owner turns privacy on', async () => {
    await call(env, 'POST', '/v1/follows/p1', { token: other });
    setPrivate();
    const res = await call(env, 'POST', '/v1/follows/p1', { token: other });
    expect(res.json).toEqual({ ok: true, following: true, requested: false });
    expect(followRow()?.state).toBe('accepted');
  });

  it('keeps every guard it had: self, block, deleted', async () => {
    expect((await call(env, 'POST', '/v1/follows/p1', { token: owner })).status).toBe(400);
    expect((await call(env, 'POST', '/v1/follows/p_nobody', { token: other })).status).toBe(404);

    setPrivate();
    raw.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ('p1','p2','2026-01-01T00:00:00Z')").run();
    expect((await call(env, 'POST', '/v1/follows/p1', { token: other })).status).toBe(403);
    expect(followRow()).toBeUndefined();
  });
});

describe('counts and lists see accepted rows only', () => {
  beforeEach(() => {
    setPrivate();
    raw
      .prepare(
        `INSERT INTO follows (follower_id, followee_id, created_at, state)
         VALUES ('p2','p1','2026-01-02T00:00:00.000Z','pending')`,
      )
      .run();
  });

  it('does not count a pending row as a follower, or as following', async () => {
    const seen = await call(env, 'GET', '/v1/profiles/mahmood', { token: owner });
    expect(seen.json.counts.followers).toBe(0);

    const mine = await call(env, 'GET', '/v1/profiles/sara', { token: other });
    expect(mine.json.counts.following).toBe(0);
  });

  it('does not list a pending row in followers, following, or /v1/me/following', async () => {
    expect((await call(env, 'GET', '/v1/profiles/mahmood/followers', { token: owner })).json.items).toEqual([]);
    expect((await call(env, 'GET', '/v1/profiles/sara/following', { token: other })).json.items).toEqual([]);
    expect((await call(env, 'GET', '/v1/me/following', { token: other })).json.items).toEqual([]);
  });

  it('reports follow_requested_by_me, never followed_by_me', async () => {
    const res = await call(env, 'GET', '/v1/profiles/mahmood', { token: other });
    expect(res.json.followed_by_me).toBe(false);
    expect(res.json.follow_requested_by_me).toBe(true);
  });
});

describe('DELETE /v1/follows/:id — unfollow AND cancel', () => {
  it('removes a pending request', async () => {
    setPrivate();
    await call(env, 'POST', '/v1/follows/p1', { token: other });
    expect((await call(env, 'DELETE', '/v1/follows/p1', { token: other })).status).toBe(204);
    expect(followRow()).toBeUndefined();

    // And the request is gone from the owner's screen, not merely from the
    // requester's button.
    expect((await call(env, 'GET', '/v1/me/follow-requests', { token: owner })).json.items).toEqual([]);
  });
});

describe('GET /v1/me/follow-requests', () => {
  it('returns the pending requesters as follower-shaped rows, newest first', async () => {
    insertProfile(raw, 'p3', 'amanda');
    setPrivate();
    raw
      .prepare(
        `INSERT INTO follows (follower_id, followee_id, created_at, state) VALUES
           ('p2','p1','2026-01-02T00:00:00.000Z','pending'),
           ('p3','p1','2026-01-05T00:00:00.000Z','pending')`,
      )
      .run();
    // An accepted follower must not appear in the queue of unanswered questions.
    insertProfile(raw, 'p4', 'omar');
    raw
      .prepare(
        `INSERT INTO follows (follower_id, followee_id, created_at, state)
         VALUES ('p4','p1','2026-01-06T00:00:00.000Z','accepted')`,
      )
      .run();

    const res = await call(env, 'GET', '/v1/me/follow-requests', { token: owner });
    expect(res.status).toBe(200);
    expect(res.json.items.map((i: { handle: string }) => i.handle)).toEqual(['amanda', 'sara']);
    expect(res.json.items[0]).toEqual({
      id: 'p3',
      handle: 'amanda',
      display_name: null,
      avatar_key: null,
      is_plus: false,
      followed_at: '2026-01-05T00:00:00.000Z',
      created_at: '2026-01-05T00:00:00.000Z',
    });
  });

  it('needs a session', async () => {
    expect((await call(env, 'GET', '/v1/me/follow-requests')).status).toBe(401);
  });
});

describe('POST /v1/me/follow-requests/:id', () => {
  const request = async () => {
    setPrivate();
    await call(env, 'POST', '/v1/follows/p1', { token: other });
  };

  it('accepts: the row is granted and the ordinary follow notification is written', async () => {
    await request();
    const res = await call(env, 'POST', '/v1/me/follow-requests/p2', {
      token: owner,
      body: { action: 'accept' },
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, following: true });
    expect(followRow()?.state).toBe('accepted');
    // The same row a public follow writes: to the owner, about the follower.
    expect(notifications('follow')).toEqual([
      expect.objectContaining({ recipient_id: 'p1', actor_id: 'p2' }),
    ]);

    // And the follower is now inside: counts, lists and the private half.
    const seen = await call(env, 'GET', '/v1/profiles/mahmood', { token: other });
    expect(seen.json.counts.followers).toBe(1);
    expect(seen.json.followed_by_me).toBe(true);
    expect(seen.json.follow_requested_by_me).toBe(false);
    expect((await call(env, 'GET', '/v1/profiles/mahmood/followers', { token: other })).status).toBe(200);
  });

  it('denies: the row is deleted and nothing at all is written', async () => {
    await request();
    const res = await call(env, 'POST', '/v1/me/follow-requests/p2', {
      token: owner,
      body: { action: 'deny' },
    });
    expect(res.json).toEqual({ ok: true, following: false });
    expect(followRow()).toBeUndefined();
    // A refusal is never announced — see the note on the route.
    expect(notifications('follow')).toHaveLength(0);
  });

  it('is 404 with no pending row — including a second answer to the same one', async () => {
    expect(
      (await call(env, 'POST', '/v1/me/follow-requests/p2', { token: owner, body: { action: 'accept' } })).status,
    ).toBe(404);

    await request();
    await call(env, 'POST', '/v1/me/follow-requests/p2', { token: owner, body: { action: 'accept' } });
    const twice = await call(env, 'POST', '/v1/me/follow-requests/p2', {
      token: owner,
      body: { action: 'accept' },
    });
    expect(twice.status).toBe(404);
    // The second answer must not have written a second notification.
    expect(notifications('follow')).toHaveLength(1);
  });

  it('refuses any other action with a 400', async () => {
    await request();
    for (const action of ['maybe', '', null, undefined, 1]) {
      const res = await call(env, 'POST', '/v1/me/follow-requests/p2', { token: owner, body: { action } });
      expect(res.status).toBe(400);
    }
    expect(followRow()?.state).toBe('pending');
  });
});

// ── per-section hiding ──────────────────────────────────────────────────────

describe('PATCH /v1/me — hidden_sections', () => {
  const patch = (hidden_sections: unknown) =>
    call(env, 'PATCH', '/v1/me', { token: owner, body: { hidden_sections } });

  it('stores a known set and hands it back on /v1/me', async () => {
    const res = await patch(['stats', 'comments']);
    expect(res.status).toBe(200);
    expect(res.json.hidden_sections).toEqual(['stats', 'comments']);
    expect((await call(env, 'GET', '/v1/me', { token: owner })).json.hidden_sections).toEqual([
      'stats',
      'comments',
    ]);
  });

  it('refuses an unknown key — a preference nothing enforces is a lie', async () => {
    expect((await patch(['stats', 'watchlist'])).status).toBe(400);
    expect((await patch('stats')).status).toBe(400);
    expect((await patch([1])).status).toBe(400);
    expect((await call(env, 'GET', '/v1/me', { token: owner })).json.hidden_sections).toEqual([]);
  });

  it('keeps `everything`, the own-profile block (2.0.3), through the PATCH and the echo', async () => {
    expect((await patch(['everything'])).status).toBe(200);
    expect((await call(env, 'GET', '/v1/me', { token: owner })).json.hidden_sections).toEqual(['everything']);
  });

  it('clears with null, and with an empty array', async () => {
    await patch(['stats']);
    expect((await patch(null)).json.hidden_sections).toEqual([]);
    await patch(['stats']);
    expect((await patch([])).json.hidden_sections).toEqual([]);
    expect(
      raw.prepare("SELECT hidden_sections AS h FROM profiles WHERE id = 'p1'").get(),
    ).toEqual({ h: null });
  });

  it('is NOT Plus-gated — privacy is not a cosmetic', async () => {
    expect(raw.prepare("SELECT is_plus AS p FROM profiles WHERE id = 'p1'").get()).toEqual({ p: 0 });
    expect((await patch(['stats', 'shows', 'movies'])).status).toBe(200);
  });
});

describe('a hidden section is ABSENT from the data, not merely flagged', () => {
  /** A profile with something in every section a stranger could read. */
  const seed = async () => {
    await call(env, 'PUT', '/v1/me/published', {
      token: owner,
      body: {
        kind: 'show',
        stats: { episodes_watched: 100, minutes_watched: 4000, movie_minutes: 500 },
        titles: [
          { target_source: 'tvdb', target_key: '1', name: 'Severance', favourite: true, rank: 0, fav_rank: 0 },
        ],
      },
    });
    await call(env, 'PUT', '/v1/me/published', {
      token: owner,
      body: {
        kind: 'movie',
        // The same totals: this intake writes the stats row on every call, so
        // sending them once would zero what the first publish stored.
        stats: { episodes_watched: 100, minutes_watched: 4000, movie_minutes: 500 },
        titles: [{ target_source: 'tmdb', target_key: '9', name: 'Arrival', favourite: true, fav_rank: 0 }],
      },
    });
    await call(env, 'POST', '/v1/published/lists', {
      token: owner,
      body: { lists: [{ name: 'Comfort shows', items: [] }] },
    });
    await call(env, 'POST', '/v1/comments', {
      token: owner,
      body: { target_source: 'tvdb', target_key: '1', body: 'Best pilot in years.' },
    });
  };

  const hide = (...keys: string[]) =>
    call(env, 'PATCH', '/v1/me', { token: owner, body: { hidden_sections: keys } });

  const publishedAs = (token?: string) =>
    call(env, 'GET', '/v1/profiles/mahmood/published', token ? { token } : {});

  beforeEach(seed);

  it('stats: null to a stranger, present for the owner', async () => {
    await hide('stats');
    expect((await publishedAs(other)).json.stats).toBeNull();
    expect((await publishedAs(owner)).json.stats.episodes_watched).toBe(100);
  });

  it('shows and movies: empty to a stranger, present for the owner', async () => {
    await hide('shows');
    const seen = await publishedAs(other);
    expect(seen.json.shows).toEqual([]);
    // Only the hidden one — hiding shows must not take the films with it.
    expect(seen.json.movies).toHaveLength(1);
    expect((await publishedAs(owner)).json.shows).toHaveLength(1);

    await hide('movies');
    expect((await publishedAs(other)).json.movies).toEqual([]);
    expect((await publishedAs(other)).json.shows).toHaveLength(1);
  });

  it('favourites: the star comes off, the titles stay', async () => {
    await hide('favourite_shows');
    const seen = await publishedAs(other);
    expect(seen.json.shows).toHaveLength(1);
    expect(seen.json.shows[0].favourite).toBe(false);
    expect(seen.json.shows[0].fav_rank).toBeNull();
    // The films' favourites are a separate switch.
    expect(seen.json.movies[0].favourite).toBe(true);
    expect((await publishedAs(owner)).json.shows[0].favourite).toBe(true);
  });

  it('lists: empty to a stranger, and the count goes with them', async () => {
    await hide('lists');
    expect((await call(env, 'GET', '/v1/profiles/mahmood/lists', { token: other })).json.items).toEqual([]);
    expect((await call(env, 'GET', '/v1/profiles/mahmood', { token: other })).json.counts.lists).toBe(0);

    const mine = await call(env, 'GET', '/v1/profiles/mahmood/lists', { token: owner });
    expect(mine.json.items).toHaveLength(1);
    expect((await call(env, 'GET', '/v1/profiles/mahmood', { token: owner })).json.counts.lists).toBe(1);
  });

  it('comments: the feed is empty to a stranger, and the count with it', async () => {
    await hide('comments');
    const seen = await call(env, 'GET', '/v1/profiles/mahmood/comments', { token: other });
    expect(seen.json).toEqual({ items: [], next_cursor: null });
    expect((await call(env, 'GET', '/v1/profiles/mahmood', { token: other })).json.counts.comments).toBe(0);

    const mine = await call(env, 'GET', '/v1/profiles/mahmood/comments', { token: owner });
    expect(mine.json.items).toHaveLength(1);
    expect((await call(env, 'GET', '/v1/profiles/mahmood', { token: owner })).json.counts.comments).toBe(1);

    // The comment itself is untouched: hiding the feed is not deleting the
    // remark, and the thread it lives in still shows it.
    const thread = await call(env, 'GET', '/v1/comments?source=tvdb&key=1');
    expect(thread.json.items).toHaveLength(1);
  });

  it('publishes the fact of hiding, to a stranger as well as the owner', async () => {
    await hide('stats', 'comments');
    expect((await call(env, 'GET', '/v1/profiles/mahmood', { token: other })).json.hidden_sections).toEqual([
      'stats',
      'comments',
    ]);
  });

  it('hides nothing when nothing is hidden — the default is unchanged', async () => {
    const seen = await publishedAs(other);
    expect(seen.json.stats.episodes_watched).toBe(100);
    expect(seen.json.shows[0].favourite).toBe(true);
    expect((await call(env, 'GET', '/v1/profiles/mahmood/lists', { token: other })).json.items).toHaveLength(1);
    expect((await call(env, 'GET', '/v1/profiles/mahmood/comments', { token: other })).json.items).toHaveLength(1);
  });
});
