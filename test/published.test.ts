import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { PLUS_MAX_TITLES, PUBLISH_MAX_TITLES } from '@/routes/published';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * The published profile — stats and shelves.
 *
 * Two things here can be quietly wrong and pass every naive test:
 *
 *  1. THE PARAMETER CEILING. D1 binds at most 100 per query, and a shelf is
 *     bound eight columns per row. A test that publishes two titles proves
 *     nothing about one that publishes two hundred — that is precisely how the
 *     aggregate list form shipped a 500 nobody saw until the 26th target.
 *  2. VISIBILITY. This endpoint hands out what somebody watches. A private
 *     profile leaking its shelves to a stranger, or a blocked account's shelves
 *     leaking at all, is the kind of bug that is invisible from the inside.
 */

let raw: Database.Database;
let env: Env;
let token: string;

const title = (i: number, over: Record<string, unknown> = {}) => ({
  target_source: 'tvdb',
  target_key: String(1000 + i),
  name: `Show ${i}`,
  poster: `https://art/${i}.jpg`,
  favourite: false,
  ...over,
});

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  token = await tokenFor(env, 'p1');
});

describe('PUT /v1/me/published', () => {
  it('stores a shelf and its stats', async () => {
    const res = await call(env, 'PUT', '/v1/me/published', {
      token,
      body: {
        kind: 'show',
        stats: { episodes_watched: 23560, minutes_watched: 850_000, movie_minutes: 12_000 },
        titles: [title(1), title(2, { favourite: true })],
      },
    });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, kind: 'show', titles: 2 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM profile_titles').get()).toEqual({ n: 2 });
    expect(raw.prepare('SELECT episodes_watched, minutes_watched, movie_minutes, shows_count FROM profile_stats').get()).toEqual({
      episodes_watched: 23560,
      // Shows and films are stored APART: the profile draws four cards, two of
      // which are about films alone, and a combined figure cannot be split back.
      minutes_watched: 850_000,
      movie_minutes: 12_000,
      shows_count: 2,
    });
  });

  it('handles a FULL shelf without exceeding D1’s parameter ceiling', async () => {
    // The harness throws above 100 binds, exactly as D1 does. Two hundred and
    // fifty rows at eight columns is 2,000 parameters: it only works chunked.
    const titles = Array.from({ length: PUBLISH_MAX_TITLES }, (_, i) => title(i));
    const res = await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'show', stats: {}, titles },
    });

    expect(res.status).toBe(200);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM profile_titles').get()).toEqual({ n: PUBLISH_MAX_TITLES });
  });

  it('REPLACES the shelf — a title dropped on the phone disappears here', async () => {
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'show', stats: {}, titles: [title(1), title(2), title(3)] },
    });
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'show', stats: {}, titles: [title(1)] },
    });

    const keys = raw.prepare('SELECT target_key FROM profile_titles').all() as { target_key: string }[];
    expect(keys.map((k) => k.target_key)).toEqual(['1001']);
  });

  it('leaves the OTHER kind alone', async () => {
    await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'show', stats: {}, titles: [title(1)] } });
    await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'movie', stats: {}, titles: [title(9)] } });

    const rows = raw.prepare('SELECT kind FROM profile_titles ORDER BY kind').all() as { kind: string }[];
    expect(rows.map((r) => r.kind)).toEqual(['movie', 'show']);
    // …and each kind's count is its own.
    expect(raw.prepare('SELECT shows_count, movies_count FROM profile_stats').get()).toEqual({
      shows_count: 1,
      movies_count: 1,
    });
  });

  it('drops a malformed title rather than the whole request', async () => {
    const res = await call(env, 'PUT', '/v1/me/published', {
      token,
      body: {
        kind: 'show',
        stats: {},
        titles: [title(1), { target_source: 'nope', target_key: 'x' }, { target_source: 'tvdb', target_key: '' }],
      },
    });
    expect(res.json.titles).toBe(1);
  });

  it('refuses more than the cap', async () => {
    const titles = Array.from({ length: PUBLISH_MAX_TITLES + 1 }, (_, i) => title(i));
    const res = await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'show', stats: {}, titles } });
    expect(res.status).toBe(413);
  });

  it('requires a session and a valid kind', async () => {
    expect((await call(env, 'PUT', '/v1/me/published', { body: { kind: 'show', titles: [] } })).status).toBe(401);
    expect(
      (await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'people', titles: [] } })).status,
    ).toBe(400);
  });
});

describe('GET /v1/profiles/:handle/published', () => {
  const publish = async () => {
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: {
        kind: 'show',
        stats: { episodes_watched: 100, minutes_watched: 4000 },
        titles: [title(1), title(2, { favourite: true, rank: 0 })],
      },
    });
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'movie', stats: { episodes_watched: 100, minutes_watched: 4000 }, titles: [title(9)] },
    });
  };

  it('returns the shelves and the stats', async () => {
    await publish();
    const res = await call(env, 'GET', '/v1/profiles/mahmood/published');

    expect(res.status).toBe(200);
    expect(res.json.stats.episodes_watched).toBe(100);
    expect(res.json.shows).toHaveLength(2);
    expect(res.json.movies).toHaveLength(1);
  });

  it('Simple view: nobody else gets the numbers, only that the owner chose it', async () => {
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'show', stats: { episodes_watched: 100, minutes_watched: 4000, simple_view: true }, titles: [title(1)] },
    });
    const other = await call(env, 'GET', '/v1/profiles/mahmood/published', { token: await tokenFor(env, 'p2') });
    expect(other.json.stats).toBeNull();
    expect(other.json.simple_view).toBe(true);
    expect(other.json.shows).toHaveLength(1);
    // The owner still reads their own row: the phone's library check compares against it.
    const mine = await call(env, 'GET', '/v1/profiles/mahmood/published', { token });
    expect(mine.json.stats.episodes_watched).toBe(100);
    // Turning it off is the next publish that does not say it.
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'show', stats: { episodes_watched: 100, minutes_watched: 4000 }, titles: [title(1)] },
    });
    const again = await call(env, 'GET', '/v1/profiles/mahmood/published');
    expect(again.json.stats.episodes_watched).toBe(100);
    expect(again.json.simple_view).toBe(false);
  });

  it('keeps the OWNER’S order — favourites are not sorted to the front', async () => {
    // The shelf is drawn in the order the phone published it. Hoisting
    // favourites would give a public profile a different order from the
    // owner's own screen, which is the whole bug this replaced.
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: {
        kind: 'show',
        stats: {},
        titles: [
          title(1, { rank: 0 }),
          title(2, { rank: 1, favourite: true, fav_rank: 0 }),
          title(3, { rank: 2 }),
        ],
      },
    });
    const res = await call(env, 'GET', '/v1/profiles/mahmood/published');
    expect(res.json.shows.map((s: { target_key: string }) => s.target_key)).toEqual(['1001', '1002', '1003']);
  });

  it('sends fav_rank, so the favourites shelf can carry its own order', async () => {
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: {
        kind: 'show',
        stats: {},
        // Published second but hearted first: the two orders disagree on
        // purpose, which is exactly why one rank column was not enough.
        titles: [title(1, { rank: 0, favourite: true, fav_rank: 1 }), title(2, { rank: 1, favourite: true, fav_rank: 0 })],
      },
    });
    const res = await call(env, 'GET', '/v1/profiles/mahmood/published');
    expect(res.json.shows.map((s: { target_key: string }) => s.target_key)).toEqual(['1001', '1002']);
    const byFav = [...res.json.shows].sort(
      (a: { fav_rank: number }, b: { fav_rank: number }) => a.fav_rank - b.fav_rank,
    );
    expect(byFav.map((s: { target_key: string }) => s.target_key)).toEqual(['1002', '1001']);
  });

  it('leaves an unranked shelf stable, ordered by name', async () => {
    await publish();
    const res = await call(env, 'GET', '/v1/profiles/mahmood/published');
    expect(res.json.shows).toHaveLength(2);
  });

  it('says stats are NULL when nothing has been published — not zero', async () => {
    // "Has watched nothing" and "has never synced" are different sentences and
    // the screen shows different things for them.
    const res = await call(env, 'GET', '/v1/profiles/sara/published');
    expect(res.status).toBe(200);
    expect(res.json.stats).toBeNull();
    expect(res.json.shows).toEqual([]);
  });

  it('is 404 for a profile that does not exist', async () => {
    expect((await call(env, 'GET', '/v1/profiles/nobody/published')).status).toBe(404);
  });

  it('hides a PRIVATE profile’s shelves from a stranger', async () => {
    await publish();
    raw.prepare("UPDATE profiles SET is_private = 1 WHERE id = 'p1'").run();

    expect((await call(env, 'GET', '/v1/profiles/mahmood/published')).status).toBe(403);
    // The owner still sees their own.
    const mine = await call(env, 'GET', '/v1/profiles/mahmood/published', { token });
    expect(mine.status).toBe(200);
    expect(mine.json.shows).toHaveLength(2);
  });

  it('shows a private profile to an accepted follower', async () => {
    await publish();
    raw.prepare("UPDATE profiles SET is_private = 1 WHERE id = 'p1'").run();
    raw
      .prepare("INSERT INTO follows (follower_id, followee_id, created_at) VALUES ('p2','p1','2026-01-01T00:00:00Z')")
      .run();

    const res = await call(env, 'GET', '/v1/profiles/mahmood/published', { token: await tokenFor(env, 'p2') });
    expect(res.status).toBe(200);
  });

  it('is 404 across a block, in either direction', async () => {
    await publish();
    const p2 = await tokenFor(env, 'p2');
    raw.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ('p1','p2','2026-01-01T00:00:00Z')").run();
    expect((await call(env, 'GET', '/v1/profiles/mahmood/published', { token: p2 })).status).toBe(404);

    raw.prepare('DELETE FROM blocks').run();
    raw.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ('p2','p1','2026-01-01T00:00:00Z')").run();
    expect((await call(env, 'GET', '/v1/profiles/mahmood/published', { token: p2 })).status).toBe(404);
  });

  it('goes with the account when it is deleted', async () => {
    await publish();
    raw.prepare("DELETE FROM profiles WHERE id = 'p1'").run();
    // ON DELETE CASCADE, so no orphaned shelf survives its owner.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM profile_titles').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM profile_stats').get()).toEqual({ n: 0 });
  });
});

/**
 * A SHELF LONGER THAN ONE REQUEST.
 *
 * 250 was never a decision about how much a profile may show — it is the
 * largest number of titles that fits in one D1 statement, and it became the
 * cap because one request was the whole protocol. These are the rules that
 * make a second request safe.
 */
describe('a shelf sent in chunks', () => {
  const plus = () =>
    raw.prepare(`UPDATE profiles SET is_plus = 1 WHERE id = 'p1'`).run();

  it('refuses to append for an account that is not Plus', async () => {
    const res = await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'show', append: true, titles: [title(1)] },
    });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('plus_required');
  });

  it('keeps the first chunk when the second appends', async () => {
    plus();
    await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'show', titles: [title(1), title(2)] } });
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'show', append: true, titles: [title(3)] },
    });

    const n = raw.prepare(`SELECT COUNT(*) AS n FROM profile_titles WHERE profile_id = 'p1'`).get() as { n: number };
    expect(n.n).toBe(3);
  });

  /* D1 throws on an empty batch: these were 500s, 21 Oct. */
  it('accepts an empty shelf, and an empty appended chunk', async () => {
    plus();
    await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'show', titles: [title(1)] } });
    const cleared = await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'show', titles: [] } });
    expect(cleared.status).toBe(200);
    const appended = await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'show', append: true, titles: [] },
    });
    expect(appended.status).toBe(200);
    const n = raw.prepare(`SELECT COUNT(*) AS n FROM profile_titles WHERE profile_id = 'p1'`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  /* The first chunk still REPLACES, or an old shelf would never shrink. */
  it('clears the shelf on the chunk that does not append', async () => {
    plus();
    await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'show', titles: [title(1), title(2)] } });
    await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'show', titles: [title(9)] } });

    const rows = raw
      .prepare(`SELECT target_key FROM profile_titles WHERE profile_id = 'p1'`)
      .all() as { target_key: string }[];
    expect(rows.map((r) => r.target_key)).toEqual(['1009']);
  });

  /* Counted on the server: a ceiling the client enforces is not a ceiling. */
  it('refuses an append that would take the shelf past the Plus ceiling', async () => {
    plus();
    const many = Array.from({ length: PUBLISH_MAX_TITLES }, (_, i) => title(i));
    await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'show', titles: many } });
    for (let round = 0; round < Math.ceil(PLUS_MAX_TITLES / PUBLISH_MAX_TITLES); round++) {
      const res = await call(env, 'PUT', '/v1/me/published', {
        token,
        body: {
          kind: 'show',
          append: true,
          titles: Array.from({ length: PUBLISH_MAX_TITLES }, (_, i) => title(10_000 + round * 1000 + i)),
        },
      });
      if (res.status === 413) {
        expect(res.json.error.code).toBe('too_large');
        return;
      }
    }
    throw new Error('the ceiling never applied');
  });
});

/*
 * "250 films" on a profile holding two thousand. The count was the length of
 * the shelf in the request, and the shelf is capped — so the cap was being
 * reported as a total, and chunking turned it into the size of the last chunk.
 */
describe('the counts on a profile are the library, not the shelf', () => {
  it('uses the totals the phone sent, not how many titles arrived', async () => {
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: {
        kind: 'movie',
        stats: { episodes_watched: 0, minutes_watched: 0, movie_minutes: 0, movies_count: 2000 },
        titles: [title(1), title(2)],
      },
    });
    expect(raw.prepare(`SELECT movies_count FROM profile_stats WHERE profile_id = 'p1'`).get()).toEqual({
      movies_count: 2000,
    });
  });

  /* An older build sends no total. Reporting the old wrong number beats
     reporting a zero. */
  it('falls back to the row count when no total was sent', async () => {
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'movie', stats: { episodes_watched: 0 }, titles: [title(1), title(2), title(3)] },
    });
    expect(raw.prepare(`SELECT movies_count FROM profile_stats WHERE profile_id = 'p1'`).get()).toEqual({
      movies_count: 3,
    });
  });
});

describe('where the day started', () => {
  const put = (episodes: number) =>
    call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'show', stats: { episodes_watched: episodes }, titles: [title(1)] } });
  const base = () => raw.prepare('SELECT day_base_episodes AS b FROM profile_stats').get() as { b: number | null };

  it('stamps the previous total on the first sync of a new day and keeps it through the day', async () => {
    await put(100);
    expect(base().b).toBeNull(); // joined: no earlier day to start from
    // Pretend that sync was yesterday.
    raw.prepare("UPDATE profile_stats SET updated_at = '2000-01-01T10:00:00.000Z'").run();
    await put(103);
    expect(base().b).toBe(100);
    await put(105);
    expect(base().b).toBe(100); // the same day: the start does not move
  });
});

describe('when a title first appeared on a shelf', () => {
  const put = (titles: ReturnType<typeof title>[]) =>
    call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'show', stats: {}, titles } });
  const seen = () =>
    raw.prepare('SELECT target_key, first_seen_at FROM shelf_seen ORDER BY target_key').all() as { target_key: string; first_seen_at: string }[];

  it('keeps the first date for a title already there and stamps only the new one', async () => {
    await put([title(1)]);
    raw.prepare("UPDATE shelf_seen SET first_seen_at = '2000-01-01T00:00:00.000Z'").run();
    await put([title(1), title(2)]);
    const rows = seen();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.first_seen_at.startsWith('2000'))).toBeDefined();
    expect(rows.filter((r) => !r.first_seen_at.startsWith('2000'))).toHaveLength(1);
  });
});

/*
 * ONE PHONE PUBLISHES A FREE PROFILE (0052). Two phones on a free account hold
 * two different libraries, and every intake here replaces — so without this
 * the public profile flipped to whichever phone published last. The phone
 * that holds it is the first to say which it is, or the last the person
 * chose (`claim`); the other is told 409 and nothing of its is written.
 */
describe('one phone publishes a free profile', () => {
  const put = (device?: string, over: Record<string, unknown> = {}) =>
    call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'show', stats: {}, titles: [title(device === 'phone-b' ? 2 : 1)], ...(device ? { device } : {}), ...over },
    });
  const lists = (device?: string) =>
    call(env, 'POST', '/v1/published/lists', {
      token,
      body: { lists: [{ name: 'Best', items: [] }], ...(device ? { device } : {}) },
    });
  const holder = () =>
    (raw.prepare("SELECT publisher_device AS d FROM profile_stats WHERE profile_id = 'p1'").get() as { d: string | null } | undefined)
      ?.d ?? null;
  const shelf = () =>
    (raw.prepare("SELECT target_key FROM profile_titles WHERE profile_id = 'p1'").all() as { target_key: string }[]).map((r) => r.target_key);

  it('the first phone to publish holds the profile; the second is told, and replaces nothing', async () => {
    expect((await put('phone-a')).status).toBe(200);
    expect(holder()).toBe('phone-a');

    const res = await put('phone-b');
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('not_publisher');
    expect(holder()).toBe('phone-a');
    expect(shelf()).toEqual(['1001']); // still A's shelf, not B's
    // The lists go the same way, and A carries on exactly as before.
    expect((await lists('phone-b')).status).toBe(409);
    expect((await put('phone-a')).status).toBe(200);
    expect((await lists('phone-a')).status).toBe(200);
  });

  it('a claim moves it, and from then on the old holder is the one told', async () => {
    await put('phone-a');
    expect((await put('phone-b', { claim: true })).status).toBe(200);
    expect(holder()).toBe('phone-b');
    expect(shelf()).toEqual(['1002']);
    // The lists follow on the same run, with no claim of their own.
    expect((await lists('phone-b')).status).toBe(200);
    expect((await put('phone-a')).status).toBe(409);
    expect((await lists('phone-a')).status).toBe(409);
    // ...until A claims it back.
    expect((await put('phone-a', { claim: true })).status).toBe(200);
    expect(holder()).toBe('phone-a');
  });

  it('never for Plus — sync keeps both libraries equal, so either phone may speak', async () => {
    raw.prepare("UPDATE profiles SET is_plus = 1 WHERE id = 'p1'").run();
    await put('phone-a');
    expect((await put('phone-b')).status).toBe(200);
    expect((await lists('phone-b')).status).toBe(200);
    expect((await put('phone-a')).status).toBe(200);
    // Still RECORDED, so a lapse leaves the last phone that spoke in charge.
    expect(holder()).toBe('phone-a');
  });

  it('a request with no device — an older build — is accepted as it always was, and forgets nobody', async () => {
    await put('phone-a');
    expect((await put()).status).toBe(200);
    expect((await lists()).status).toBe(200);
    expect(holder()).toBe('phone-a');
    // And a profile nobody has claimed takes whoever speaks first.
    raw.prepare("UPDATE profile_stats SET publisher_device = NULL WHERE profile_id = 'p1'").run();
    expect((await put('phone-b')).status).toBe(200);
    expect(holder()).toBe('phone-b');
  });
});

describe('two lists whose names differ only in case', () => {
  it('publishes the first instead of failing the whole set', async () => {
    const res = await call(env, 'POST', '/v1/published/lists', {
      token,
      body: { lists: [{ name: 'Favourites', items: [] }, { name: 'favourites', items: [] }, { name: 'Later', items: [] }] },
    });
    expect(res.status).toBe(200);
    const names = (raw.prepare("SELECT name FROM lists WHERE owner_id = 'p1' ORDER BY position").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(['Favourites', 'Later']);
  });
});
