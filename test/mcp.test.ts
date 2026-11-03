import { getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import worker from '@/index';
import { lists, parseLibrary, ratings, searchLibrary, showProgress, stats, watchHistory } from '@/mcp/library';
import { oauthOptions } from '@/mcp/oauth-options';
import { loadLibrary } from '@/mcp/server';
import { consumeCode } from '@/routes/mcp';
import { call, fakeBucket, freshDatabase, insertProfile, kv, makeEnv, tokenFor } from './harness';

// ── a backup ZIP in the shape `mobile/src/exporter.ts` writes ────────────────

const csv = (rows: Record<string, string | number>[]): string => {
  if (rows.length === 0) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n') + '\n';
};

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function backupZip({ extras = true }: { extras?: boolean } = {}): Uint8Array {
  const files: Record<string, string> = {
    'routing-prod-users.csv': csv([{ username: 'amanda', user_id: '1' }]),
    'user_tv_show_data.csv': csv([
      { tv_show_id: 100, tv_show_name: 'Breaking Bad', is_followed: 1, is_favorited: 0, nb_episodes_seen: 3, user_id: 1 },
      { tv_show_id: 200, tv_show_name: 'Pokémon', is_followed: 1, is_favorited: 0, nb_episodes_seen: 1, user_id: 1 },
      { tv_show_id: 300, tv_show_name: 'Dark', is_followed: 1, is_favorited: 0, nb_episodes_seen: 0, user_id: 1 },
      { tv_show_id: 400, tv_show_name: 'Lost', is_followed: 0, is_favorited: 0, nb_episodes_seen: 0, user_id: 1 },
    ]),
    'followed_tv_show.csv': csv([
      { tv_show_id: 100, archived: 0, active: 1 },
      { tv_show_id: 400, archived: 1, active: 0 },
    ]),
    'tracking-prod-records-v2.csv': csv([
      { s_id: 100, series_name: 'Breaking Bad', season_number: 1, episode_number: 1, created_at: '2024-01-10 20:00:00', runtime: 47, rewatch_count: 0 },
      { s_id: 100, series_name: 'Breaking Bad', season_number: 1, episode_number: 2, created_at: '2024-01-11 20:00:00', runtime: 47, rewatch_count: 0 },
      { s_id: 100, series_name: 'Breaking Bad', season_number: 2, episode_number: 1, created_at: '2025-02-01T21:00:00.000Z', runtime: 47, rewatch_count: 0 },
      { s_id: 100, series_name: 'Breaking Bad', season_number: 1, episode_number: 1, created_at: '2025-03-01 20:00:00', runtime: 47, rewatch_count: 1 },
      { s_id: 200, series_name: 'Pokémon', season_number: 1, episode_number: 1, created_at: '2023-12-31 09:00:00', runtime: 22, rewatch_count: 0 },
    ]),
    'tracking-prod-records.csv': csv([
      { type: 'watch', entity_type: 'movie', movie_name: 'Inception', created_at: '2024-06-01 22:00:00', runtime: 148, rewatch_count: 2, uuid: U(1) },
      { type: 'towatch', entity_type: 'movie', movie_name: 'Dune', created_at: '2024-07-01 10:00:00', runtime: '', rewatch_count: 0, uuid: U(2) },
      { type: 'watch', entity_type: 'movie', movie_name: 'Amélie', created_at: '2025-01-05 19:00:00', runtime: '', rewatch_count: 0, uuid: U(3) },
    ]),
    // Whole stars in TV Time's 0..3 shape: 3 = five stars, 2 = four.
    'ratings-3-prod-episode_votes.csv': csv([{ vote_key: '0-1-3', series_name: 'Breaking Bad', season_number: 1, episode_number: 1 }]),
    'ratings-live-votes.csv': csv([
      { vote_key: '0-1-3', movie_name: 'Inception', episode_id: 0 },
      { vote_key: '0-1-2', movie_name: 'Amélie', episode_id: 0 },
    ]),
    'lists-prod-lists.csv': csv([
      { type: 'list', s_key: 'favorite-series', name: '', objects: '[map[id:100 type:series]]' },
      { type: 'list', s_key: 'favorite-movies', name: '', objects: `[map[type:movie uuid:${U(1)}]]` },
      {
        type: 'list',
        s_key: 'custom-1',
        name: 'Weekend',
        objects: `[map[id:200 type:series] map[type:movie uuid:${U(2)}] map[type:movie uuid:${U(99)}]]`,
      },
    ]),
  };
  if (extras) {
    files['_opentv_extras.json'] = JSON.stringify({
      movies: [{ name: 'Inception', stars: 9, year: '2010' }],
      epStars: [
        { showId: 100, season: 1, episode: 1, stars: 9 },
        { showId: 100, season: 1, episode: 2, stars: 6 },
      ],
      movieScale: 10,
      epScale: 10,
    });
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

// ── the library and the six answers ──────────────────────────────────────────

describe('the backup, read', () => {
  const lib = parseLibrary(backupZip());

  it('reads shows, watches, films, ratings and lists out of the ZIP', () => {
    expect(lib.shows.map((s) => s.name)).toEqual(['Breaking Bad', 'Pokémon', 'Dark', 'Lost']);
    expect(lib.watches).toHaveLength(5);
    expect(lib.films.map((f) => f.name).sort()).toEqual(['Amélie', 'Dune', 'Inception']);
    expect(lib.shows.find((s) => s.name === 'Lost')?.archived).toBe(true);
    // The favourites rows, not the CSV flag, are where a favourite lives.
    expect(lib.shows.find((s) => s.name === 'Breaking Bad')?.favourite).toBe(true);
  });

  it('search: case- and accent-blind, show and film summaries, ratings out of five', () => {
    expect(searchLibrary(lib, 'POKEMON').shows.map((s) => s.title)).toEqual(['Pokémon']);
    expect(searchLibrary(lib, 'amelie').films.map((f) => f.title)).toEqual(['Amélie']);

    const bb = searchLibrary(lib, 'breaking').shows[0]!;
    expect(bb).toMatchObject({
      title: 'Breaking Bad',
      episodesWatched: 3,
      watchesIncludingRewatches: 4,
      firstWatched: '2024-01-10',
      lastWatched: '2025-03-01',
      favourite: true,
      // 9/10 and 6/10 → 4.5 and 3 stars → 3.75, to the nearest half
      averageEpisodeRating: 4,
      episodesRated: 2,
    });

    // The sidecar's 9/10 wins over the CSV's whole five.
    expect(searchLibrary(lib, 'incep').films[0]).toMatchObject({
      rating: 4.5,
      rewatches: 2,
      lastWatched: '2024-06-01',
      onWatchlist: false,
      favourite: true,
      year: '2010',
    });
    expect(searchLibrary(lib, 'dune').films[0]).toMatchObject({ watched: false, onWatchlist: true, rating: null });
    expect(searchLibrary(lib, '  ').shows).toEqual([]);
  });

  it('watch history: inclusive range, newest first, capped with a count', () => {
    const y2024 = watchHistory(lib, '2024-01-01', '2024-12-31');
    expect(y2024.total).toBe(3);
    expect(y2024.items.map((i) => `${i.date} ${i.title}`)).toEqual([
      '2024-06-01 Inception',
      '2024-01-11 Breaking Bad',
      '2024-01-10 Breaking Bad',
    ]);
    expect(watchHistory(lib, '2024-01-01', '2024-12-31', 'films').total).toBe(1);
    expect(watchHistory(lib, '2025-02-01', '2025-02-01', 'episodes').items).toEqual([
      { date: '2025-02-01', type: 'episode', title: 'Breaking Bad', season: 2, episode: 1 },
    ]);
    const capped = watchHistory(lib, '2000-01-01', '2030-01-01', 'all', 2);
    expect(capped.items).toHaveLength(2);
    expect(capped.more).toBe(5);
  });

  it('show progress: per season, the last episode and when', () => {
    const p = showProgress(lib, 'breaking bad');
    expect(p.found).toBe(true);
    expect('seasons' in p && p.seasons).toEqual([
      { season: 1, episodesWatched: 2, lastWatched: '2025-03-01', lastEpisode: 1 },
      { season: 2, episodesWatched: 1, lastWatched: '2025-02-01', lastEpisode: 1 },
    ]);
    expect(showProgress(lib, 'The Wire')).toEqual({ found: false, title: 'The Wire' });
  });

  it('stats: a year, all time, hours only where runtime is known', () => {
    expect(stats(lib, 2024)).toMatchObject({
      period: '2024',
      episodesWatched: 2,
      filmsWatched: 1,
      // 47 + 47 + 148 minutes
      hoursWatched: 4,
      topShows: [{ title: 'Breaking Bad', episodes: 2 }],
    });
    const all = stats(lib);
    expect(all).toMatchObject({ episodesWatched: 5, showsWatched: 2, filmsWatched: 2, itemsWithoutRuntime: 1 });
    expect(all.ratingDistributionAllTime).toEqual({ episodes: { '3': 1, '4.5': 1 }, films: { '4': 1, '4.5': 1 } });
  });

  it('ratings: highest first, filtered by kind and stars', () => {
    expect(ratings(lib).items.map((r) => `${r.stars} ${r.title}`)).toEqual([
      '4.5 Breaking Bad',
      '4.5 Inception',
      '4 Amélie',
      '3 Breaking Bad',
    ]);
    expect(ratings(lib, 'films', 4.5).items.map((r) => r.title)).toEqual(['Inception']);
    expect(ratings(lib, 'episodes', 0, 3.5).items).toEqual([{ type: 'episode', title: 'Breaking Bad', season: 1, episode: 2, stars: 3 }]);
  });

  it('lists: watchlist, not started, favourites, and custom lists with the films nobody can name', () => {
    expect(lists(lib)).toEqual({
      watchlistFilms: { total: 1, titles: ['Dune'] },
      followedShowsNotStarted: { total: 1, titles: ['Dark'] },
      favourites: { shows: ['Breaking Bad'], films: ['Inception'] },
      lists: [{ name: 'Weekend', total: 3, items: ['Pokémon', 'Dune'], filmsWithoutATitle: 1 }],
    });
  });

  it('a backup without the sidecar falls back to the CSV whole stars, matching shows by name', () => {
    const old = parseLibrary(backupZip({ extras: false }));
    expect(old.films.find((f) => f.name === 'Inception')?.stars).toBe(5);
    expect(old.episodeRatings).toEqual([{ showId: 100, season: 1, episode: 1, stars: 5 }]);
  });
});

// ── the code the phone shows ─────────────────────────────────────────────────

describe('POST /v1/mcp/code', () => {
  let env: Env;
  let raw: ReturnType<typeof freshDatabase>['raw'];
  let bucket: ReturnType<typeof fakeBucket>;
  let token: string;

  beforeEach(async () => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    bucket = fakeBucket();
    env = makeEnv(fresh.db, undefined, bucket);
    insertProfile(raw, 'p1', 'amanda');
    raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run('p1');
    token = await tokenFor(env, 'p1');
  });
  afterEach(() => vi.useRealTimers());

  const withBackup = () => bucket.put('backups/p1/dev1.zip', backupZip().buffer as ArrayBuffer);

  it('needs Plus', async () => {
    raw.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ?').run('p1');
    await withBackup();
    const res = await call(env, 'POST', '/v1/mcp/code', { token });
    expect(res.status).toBe(402);
    expect(res.json.error.code).toBe('plus_required');
  });

  it('needs a backup on the server', async () => {
    const res = await call(env, 'POST', '/v1/mcp/code', { token });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('no_backup');
  });

  it('hands out six digits for five minutes, used once', async () => {
    await withBackup();
    const before = Date.now();
    const res = await call(env, 'POST', '/v1/mcp/code', { token });
    expect(res.status).toBe(200);
    expect(res.json.code).toMatch(/^\d{6}$/);
    const ttl = Date.parse(res.json.expiresAt) - before;
    expect(ttl).toBeGreaterThan(299_000);
    expect(ttl).toBeLessThanOrEqual(301_000);

    expect(await consumeCode(env, res.json.code, Date.now())).toBe('p1');
    expect(await consumeCode(env, res.json.code, Date.now())).toBeNull();
  });

  it('expires after five minutes even if the store still has it', async () => {
    await withBackup();
    const { json } = await call(env, 'POST', '/v1/mcp/code', { token });
    expect(await consumeCode(env, json.code, Date.now() + 301_000)).toBeNull();
  });

  it('a new code replaces the last one', async () => {
    await withBackup();
    const first = (await call(env, 'POST', '/v1/mcp/code', { token })).json.code;
    const second = (await call(env, 'POST', '/v1/mcp/code', { token })).json.code;
    if (first !== second) expect(await consumeCode(env, first, Date.now())).toBeNull();
    expect(await consumeCode(env, second, Date.now())).toBe('p1');
  });

  it('is rate-limited per member', async () => {
    await withBackup();
    for (let i = 0; i < 5; i++) expect((await call(env, 'POST', '/v1/mcp/code', { token })).status).toBe(200);
    expect((await call(env, 'POST', '/v1/mcp/code', { token })).status).toBe(429);
  });

  it('needs a session', async () => {
    expect((await call(env, 'POST', '/v1/mcp/code')).status).toBe(401);
  });
});

// ── reading the backup for a tool ────────────────────────────────────────────

describe('loadLibrary', () => {
  it('reads the fullest backup, and answers null when there is none', async () => {
    const { db } = freshDatabase();
    const bucket = fakeBucket();
    const env = makeEnv(db, undefined, bucket);
    expect(await loadLibrary(env, 'p9')).toBeNull();
    await bucket.put('backups/p9/a.zip', backupZip().buffer as ArrayBuffer);
    const loaded = await loadLibrary(env, 'p9');
    expect(loaded?.lib.shows).toHaveLength(4);
    // A second call is served from memory: the same parsed object.
    expect((await loadLibrary(env, 'p9'))?.lib).toBe(loaded?.lib);
  });
});

// ── the consent page and the connections it makes ────────────────────────────

const ORIGIN = 'https://api.opentv.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function send(env: Env, method: string, path: string, init: { form?: Record<string, string>; cookie?: string } = {}) {
  const headers = new Headers();
  if (init.cookie) headers.set('Cookie', init.cookie);
  let body: string | undefined;
  if (init.form) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams(init.form).toString();
  }
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

describe('linking Claude: /authorize and the connections', () => {
  let env: Env;
  let raw: ReturnType<typeof freshDatabase>['raw'];
  let clientId: string;

  beforeEach(async () => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    const bucket = fakeBucket();
    env = { ...makeEnv(fresh.db, undefined, bucket), OAUTH_KV: kv() };
    const noop = { fetch: () => new Response(null) };
    env.OAUTH_PROVIDER = getOAuthApi(oauthOptions(ORIGIN, { apiHandler: noop, defaultHandler: noop }), env);
    for (const [id, handle] of [['p1', 'amanda'], ['p2', 'opentvtestamanda']] as const) {
      insertProfile(raw, id, handle);
      raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run(id);
      await bucket.put(`backups/${id}/dev.zip`, backupZip().buffer as ArrayBuffer);
    }
    const client = await env.OAUTH_PROVIDER.createClient({
      redirectUris: [REDIRECT],
      clientName: 'Claude <script>',
      tokenEndpointAuthMethod: 'none',
    });
    clientId = client.clientId;
  });

  const authorizeUrl = () =>
    `/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: 'mcp:read offline_access',
      state: 'st4te',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      resource: `${ORIGIN}/mcp`,
    })}`;

  /** The consent page, its handle, and the cookie that binds the handle to this browser. */
  async function open() {
    const res = await send(env, 'GET', authorizeUrl());
    expect(res.status).toBe(200);
    const handle = /name="handle" value="([^"]+)"/.exec(res.text)?.[1];
    const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return { res, handle: handle!, cookie };
  }

  async function link(profileId: string): Promise<string> {
    const token = await tokenFor(env, profileId);
    const code = (await call(env, 'POST', '/v1/mcp/code', { token })).json.code as string;
    const { handle, cookie } = await open();
    const res = await send(env, 'POST', '/authorize', { form: { handle, code, decision: 'approve' }, cookie });
    expect(res.status).toBe(302);
    return res.headers.get('Location')!;
  }

  it('the page names the client, escaped, and where access goes', async () => {
    const { res } = await open();
    expect(res.text).toContain('Claude &#60;script&#62;');
    expect(res.text).not.toContain('<script>');
    expect(res.text).toContain('claude.ai');
    expect(res.text).toContain('Settings → Claude &amp; ChatGPT');
    expect(res.headers.get('X-Frame-Options') ?? res.headers.get('Content-Security-Policy')).toBeTruthy();
  });

  it('a wrong code re-shows the page and the same handle still works', async () => {
    const { handle, cookie } = await open();
    const wrong = await send(env, 'POST', '/authorize', { form: { handle, code: '000000', decision: 'approve' }, cookie });
    expect(wrong.status).toBe(400);
    expect(wrong.text).toContain('wrong or has expired');

    const code = (await call(env, 'POST', '/v1/mcp/code', { token: await tokenFor(env, 'p1') })).json.code;
    const ok = await send(env, 'POST', '/authorize', { form: { handle, code, decision: 'approve' }, cookie });
    expect(ok.status).toBe(302);
    const to = new URL(ok.headers.get('Location')!);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get('code')).toBeTruthy();
    expect(to.searchParams.get('state')).toBe('st4te');
  });

  it('Deny sends access_denied back to the client', async () => {
    const { handle, cookie } = await open();
    const res = await send(env, 'POST', '/authorize', { form: { handle, decision: 'deny' }, cookie });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('a member without Plus cannot link', async () => {
    const code = (await call(env, 'POST', '/v1/mcp/code', { token: await tokenFor(env, 'p1') })).json.code;
    raw.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ?').run('p1');
    const { handle, cookie } = await open();
    const res = await send(env, 'POST', '/authorize', { form: { handle, code, decision: 'approve' }, cookie });
    expect(res.status).toBe(402);
  });

  it('lists a member’s connections and revokes only their own', async () => {
    await link('p1');
    await link('p2');
    const t1 = await tokenFor(env, 'p1');
    const t2 = await tokenFor(env, 'p2');

    const mine = await call(env, 'GET', '/v1/mcp/connections', { token: t1 });
    expect(mine.status).toBe(200);
    expect(mine.json.connections).toHaveLength(1);
    expect(mine.json.connections[0]).toMatchObject({ client: 'Claude <script>' });
    expect(Date.parse(mine.json.connections[0].createdAt)).toBeGreaterThan(Date.parse('2026-01-01'));
    const theirs = (await call(env, 'GET', '/v1/mcp/connections', { token: t2 })).json.connections[0].id;

    // p1 cannot revoke p2's grant…
    expect((await call(env, 'DELETE', `/v1/mcp/connections/${theirs}`, { token: t1 })).status).toBe(404);
    expect((await call(env, 'GET', '/v1/mcp/connections', { token: t2 })).json.connections).toHaveLength(1);

    // …and can revoke their own.
    const del = await call(env, 'DELETE', `/v1/mcp/connections/${mine.json.connections[0].id}`, { token: t1 });
    expect(del.json).toEqual({ ok: true });
    expect((await call(env, 'GET', '/v1/mcp/connections', { token: t1 })).json.connections).toEqual([]);
  });

  it('answers not_configured where there is no OAuth provider', async () => {
    const bare = { ...env, OAUTH_PROVIDER: undefined };
    expect((await call(bare, 'GET', '/v1/mcp/connections', { token: await tokenFor(bare, 'p1') })).status).toBe(503);
  });
});
