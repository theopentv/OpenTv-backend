import { getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import worker from '@/index';
import {
  applyOps,
  lists,
  parseLibrary,
  planFeeling,
  planMarkEpisode,
  planMarkFilm,
  planRate,
  planUnmarkEpisode,
  planWatchlist,
  ratings,
  searchLibrary,
  showProgress,
  stats,
  watchHistory,
  type Plan,
} from '@/mcp/library';
import { MCP_SCOPES, oauthOptions } from '@/mcp/oauth-options';
import { buildServer, clientLabel, countCall, LANDS, loadLibrary, NO_SYNC, NO_WRITE_SCOPE } from '@/mcp/server';
import { hashPassword } from '@/passwords';
import { consumeCode } from '@/routes/mcp';
import { buildReviewBackup } from '../scripts/make-review-backup';
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

describe('the directory reviewers’ sample library (scripts/make-review-backup.ts)', () => {
  const { zip, counts } = buildReviewBackup();
  const lib = parseLibrary(zip);

  it('reads back as a full library, and the printed counts match it', () => {
    expect(counts).toEqual({ shows: lib.shows.length, episodes: lib.watches.length, movies: lib.films.length, filmsWatched: 7 });
    expect(searchLibrary(lib, 'breaking bad').shows[0]).toMatchObject({ title: 'Breaking Bad', episodesWatched: 13, favourite: true, averageEpisodeRating: 4.5 });
    expect(searchLibrary(lib, 'interstellar').films[0]).toMatchObject({ rating: 5, rewatches: 1, favourite: true, year: '2014' });
    const all = stats(lib);
    expect(all).toMatchObject({ episodesWatched: counts.episodes, showsWatched: 7, filmsWatched: 7, itemsWithoutRuntime: 0 });
    expect(all.hoursWatched).toBeGreaterThan(50);
    expect(watchHistory(lib, '2025-01-01', '2026-12-31').total).toBe(counts.episodes + 7);
    expect(lists(lib)).toMatchObject({
      watchlistFilms: { total: 3, titles: expect.arrayContaining(['Oppenheimer', 'Past Lives', 'Arrival']) },
      followedShowsNotStarted: { total: 1, titles: ['Wednesday'] },
      favourites: { shows: ['Breaking Bad', 'Stranger Things', 'Arcane'], films: ['Interstellar', 'Spirited Away'] },
      // Every film in the list has a title: nothing for a model to apologise for.
      lists: [{ name: 'Weekend picks', total: 4, items: ['Dark', 'Chernobyl', 'Arrival', 'Past Lives'] }],
    });
    expect(ratings(lib, 'episodes').items).toHaveLength(6);
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
    // The page now offers changes too, so the grant carries the write scope.
    expect((await env.OAUTH_PROVIDER!.listUserGrants('p1')).items[0]!.scope).toEqual(expect.arrayContaining(['mcp:read', 'mcp:write']));
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

  describe('or an email and password, for people without the phone (the directory reviewers)', () => {
    const PASSWORD = 'review-demo-pass-1';
    beforeEach(async () => {
      const t = new Date().toISOString();
      raw
        .prepare(
          'INSERT INTO email_credentials (profile_id, email, email_lower, password_hash, verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run('p1', 'Review@OpenTV.test', 'review@opentv.test', await hashPassword(PASSWORD), t, t, t);
    });
    const byEmail = async (h: { handle: string; cookie: string }, email: string, password: string) =>
      send(env, 'POST', '/authorize', { form: { handle: h.handle, via: 'email', email, password, decision: 'approve' }, cookie: h.cookie });

    it('the code comes first; the email form is second, folded, with the right autocomplete', async () => {
      const { res } = await open();
      expect(res.text.indexOf('name="code"')).toBeLessThan(res.text.indexOf('name="email"'));
      expect(res.text).toContain('No code?');
      expect(res.text).toContain('autocomplete="email"');
      expect(res.text).toContain('autocomplete="current-password"');
    });

    it('the right password links that profile', async () => {
      const res = await byEmail(await open(), ' review@opentv.test ', PASSWORD);
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('Location')!).searchParams.get('code')).toBeTruthy();
      expect((await env.OAUTH_PROVIDER!.listUserGrants('p1')).items).toHaveLength(1);
      expect((await env.OAUTH_PROVIDER!.listUserGrants('p2')).items).toHaveLength(0);
    });

    it('a wrong password and an unknown address read the same, and the handle survives', async () => {
      const h = await open();
      const wrong = await byEmail(h, 'review@opentv.test', 'nope-nope-nope');
      const nobody = await byEmail(h, 'nobody@opentv.test', 'nope-nope-nope');
      for (const r of [wrong, nobody]) {
        expect(r.status).toBe(400);
        expect(r.text).toContain('Wrong email or password.');
        expect(r.text).toContain('<details open>');
        expect(r.text).not.toContain('nope-nope-nope');
      }
      expect((await byEmail(h, 'review@opentv.test', PASSWORD)).status).toBe(302);
    });

    it('an unconfirmed address is refused', async () => {
      raw.prepare('UPDATE email_credentials SET verified_at = NULL').run();
      const res = await byEmail(await open(), 'review@opentv.test', PASSWORD);
      expect(res.status).toBe(403);
      expect(res.text).toContain('Confirm this email address');
    });

    it('a deleted profile is refused like an unknown one', async () => {
      raw.prepare("UPDATE profiles SET deleted_at = '2026-11-01T00:00:00Z' WHERE id = 'p1'").run();
      expect((await byEmail(await open(), 'review@opentv.test', PASSWORD)).status).toBe(400);
    });

    it('without Plus it cannot link', async () => {
      raw.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ?').run('p1');
      const res = await byEmail(await open(), 'review@opentv.test', PASSWORD);
      expect(res.status).toBe(402);
      expect(res.text).toContain('does not have Plus');
    });

    it('is rate-limited per address, and per IP across both forms', async () => {
      const h = await open();
      for (let i = 0; i < 5; i++) expect((await byEmail(h, 'review@opentv.test', `wrong-${i}-xx`)).status).toBe(400);
      // Even the right password, now: the address has had its five.
      expect((await byEmail(h, 'review@opentv.test', PASSWORD)).status).toBe(429);
      // Five more from this IP (four codes and the 429 above make ten) and the codes stop too.
      for (let i = 0; i < 4; i++) {
        expect((await send(env, 'POST', '/authorize', { form: { handle: h.handle, code: '000000', decision: 'approve' }, cookie: h.cookie })).status).toBe(400);
      }
      expect((await send(env, 'POST', '/authorize', { form: { handle: h.handle, code: '000000', decision: 'approve' }, cookie: h.cookie })).status).toBe(429);
    });
  });

  it('answers not_configured where there is no OAuth provider', async () => {
    const bare = { ...env, OAUTH_PROVIDER: undefined };
    expect((await call(bare, 'GET', '/v1/mcp/connections', { token: await tokenFor(bare, 'p1') })).status).toBe(503);
  });
});

// ── writes: the ops the phones already apply ─────────────────────────────────
//
// Every expected payload below is `Action` in `mobile/src/sync-ops.ts` with its
// `t` taken off as `kind` — what the phone's `parseOp` reads. The mobile suite
// (`sync-ops.test.ts`, "ops the assistant writes") parses these same payloads.

const opsOf = (p: Plan) => {
  if ('refuse' in p) throw new Error(`refused: ${p.refuse}`);
  return p.ops.map((o) => ({ kind: o.kind, ...JSON.parse(o.payload) }));
};
const refusal = (p: Plan) => ('refuse' in p ? p.refuse : null);

describe('write plans', () => {
  const lib = parseLibrary(backupZip());
  const now = new Date('2026-11-04T10:00:00Z');

  it('mark an episode: `watch` with the TheTVDB id and the phone’s watchedAt shape', () => {
    expect(opsOf(planMarkEpisode(lib, 'breaking bad', 3, 1, '2026-11-01', now))).toEqual([
      { kind: 'watch', show: 100, s: 3, e: 1, at: '2026-11-01 12:00:00' },
    ]);
    expect(opsOf(planMarkEpisode(lib, 'Dark', 1, 1, undefined, now))).toEqual([{ kind: 'watch', show: 300, s: 1, e: 1, at: '2026-11-04 10:00:00' }]);
    expect(refusal(planMarkEpisode(lib, 'Breaking Bad', 1, 1, undefined, now))).toMatch(/already marked watched/);
    expect(refusal(planMarkEpisode(lib, 'The Wire', 1, 1, undefined, now))).toMatch(/not in this OpenTV library/);
    expect(refusal(planMarkEpisode(lib, 'Dark', 1, 1, '2027-01-01', now))).toMatch(/future/);
    expect(refusal(planMarkEpisode(lib, 'Dark', 1, 1, 'soon', now))).toMatch(/not a date/);
  });

  it('un-mark: `unwatch`, only for an episode that is watched', () => {
    expect(opsOf(planUnmarkEpisode(lib, 'Breaking Bad', 1, 2))).toEqual([{ kind: 'unwatch', show: 100, s: 1, e: 2 }]);
    expect(refusal(planUnmarkEpisode(lib, 'Breaking Bad', 9, 9))).toMatch(/not marked watched/);
  });

  it('mark a film: `movieWatch` on the library’s own name; a new one is `movieAdd` first', () => {
    expect(opsOf(planMarkFilm(lib, 'dune'))).toEqual([{ kind: 'movieWatch', name: 'Dune', on: true }]);
    expect(refusal(planMarkFilm(lib, 'Inception'))).toMatch(/already marked watched/);
    expect(opsOf(planMarkFilm(lib, 'Arrival', '2016'))).toEqual([
      { kind: 'movieAdd', name: 'Arrival', poster: null, year: '2016', tmdbId: null },
      { kind: 'movieWatch', name: 'Arrival', on: true },
    ]);
  });

  it('rate: halves become out of ten, with the whole star a 1.7 phone reads', () => {
    expect(opsOf(planRate(lib, 'Breaking Bad', 3.5, 2, 1))).toEqual([{ kind: 'rate', show: 100, s: 2, e: 1, ten: 7, stars: 4 }]);
    expect(opsOf(planRate(lib, 'Amélie', 5))).toEqual([{ kind: 'movieStars', name: 'Amélie', ten: 10, stars: 5 }]);
    expect(opsOf(planRate(lib, 'Amelie', 0.5))).toEqual([{ kind: 'movieStars', name: 'Amélie', ten: 1, stars: 1 }]);
    expect(refusal(planRate(lib, 'Amélie', 3.3))).toMatch(/halves/);
    expect(refusal(planRate(lib, 'Arrival', 4))).toMatch(/not a film in this OpenTV library/);
    expect(refusal(planRate(lib, 'Breaking Bad', 4, 1))).toMatch(/both a season and an episode/);
  });

  it('watchlist: `movieAdd` for a new film, `showFlag followed` for a show', () => {
    expect(opsOf(planWatchlist(lib, 'Arrival', 'film'))).toEqual([{ kind: 'movieAdd', name: 'Arrival', poster: null, year: null, tmdbId: null }]);
    expect(refusal(planWatchlist(lib, 'Dune', 'film'))).toMatch(/already in the library/);
    expect(opsOf(planWatchlist(lib, 'Lost', 'show'))).toEqual([{ kind: 'showFlag', show: 400, flag: 'followed', on: true }]);
    expect(refusal(planWatchlist(lib, 'Breaking Bad', 'show'))).toMatch(/already followed/);
  });

  it('feeling: `emotion` by the phone’s index, as the resulting state', () => {
    expect(opsOf(planFeeling(lib, 'Dark', 1, 1, 'tense', true))).toEqual([{ kind: 'emotion', show: 300, s: 1, e: 1, emotion: 11, on: true }]);
    expect(opsOf(planFeeling(lib, 'Dark', 1, 1, 'shocked', false))).toEqual([{ kind: 'emotion', show: 300, s: 1, e: 1, emotion: 0, on: false }]);
  });

  it('several partial matches are asked about, never guessed', () => {
    const two = applyOps(lib, [{ ts: 1, kind: 'showAdd', payload: JSON.stringify({ show: 500, name: 'Breaking Point', poster: null }) }]);
    expect(refusal(planMarkEpisode(two, 'breaking', 1, 1, undefined, now))).toMatch(/Several shows.*Breaking Bad; Breaking Point/);
  });
});

describe('fresh reads: relay ops replayed over the backup', () => {
  const lib = parseLibrary(backupZip());
  const op = (ts: number, kind: string, body: object) => ({ ts, kind, payload: JSON.stringify(body) });

  it('applies what the phones apply, in device-clock order, without touching the cached library', () => {
    const before = JSON.stringify(searchLibrary(lib, 'breaking'));
    const ts = Date.parse('2026-11-02T20:00:00Z');
    const fresh = applyOps(lib, [
      op(ts + 120_000, 'unwatch', { show: 100, s: 1, e: 2 }),
      op(ts, 'watch', { show: 100, s: 3, e: 1, at: '2026-11-02 20:00:00' }),
      op(ts, 'rate', { show: 100, s: 3, e: 1, ten: 7, stars: 4 }),
      op(ts, 'movieAdd', { name: 'Arrival', poster: null, year: '2016', tmdbId: null }),
      op(ts + 60_000, 'movieWatch', { name: 'Arrival', on: true }),
      op(ts, 'movieStars', { name: 'Inception', ten: null, stars: null }),
      op(ts, 'movieDelete', { name: 'Amélie' }),
      op(ts, 'showFlag', { show: 400, flag: 'archived', on: false }),
      op(ts, 'emotion', { show: 100, s: 1, e: 1, emotion: 3, on: true }),
      op(ts, 'someFutureKind', { x: 1 }),
      { ts, kind: 'watch', payload: 'not json' },
    ]);
    expect(watchHistory(fresh, '2026-11-02', '2026-11-02').items).toEqual([
      { date: '2026-11-02', type: 'film', title: 'Arrival' },
      { date: '2026-11-02', type: 'episode', title: 'Breaking Bad', season: 3, episode: 1 },
    ]);
    expect(showProgress(fresh, 'Breaking Bad')).toMatchObject({ episodesWatched: 3 });
    expect(ratings(fresh, 'episodes').items).toContainEqual({ type: 'episode', title: 'Breaking Bad', season: 3, episode: 1, stars: 3.5 });
    expect(searchLibrary(fresh, 'inception').films[0]?.rating).toBeNull();
    expect(searchLibrary(fresh, 'amelie').films).toEqual([]);
    expect(fresh.shows.find((s) => s.id === 400)?.archived).toBe(false);
    // The cached parse is the next call's starting point, and is untouched.
    expect(JSON.stringify(searchLibrary(lib, 'breaking'))).toBe(before);
    expect(applyOps(lib, [])).toBe(lib);
  });

  it('a show first met as a tick appears under its id until named', () => {
    const fresh = applyOps(lib, [op(1, 'watch', { show: 777, s: 1, e: 1, at: '2026-11-01 10:00:00' }), op(2, 'showAdd', { show: 777, name: 'Severance', poster: null })]);
    expect(showProgress(fresh, 'severance')).toMatchObject({ found: true, episodesWatched: 1 });
  });
});

describe('the MCP server: annotations, gates, relay, usage', () => {
  let env: Env;
  let raw: ReturnType<typeof freshDatabase>['raw'];

  type Tool = { annotations?: Record<string, unknown>; handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> };
  const tools = (canWrite = true, client = 'Claude') =>
    (buildServer(env, 'p1', { canWrite, client }) as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  const run = async (name: string, args: unknown, canWrite = true) => {
    const r = await tools(canWrite)[name]!.handler(args, {});
    return { text: r.content[0]!.text, error: !!r.isError };
  };
  const relayed = () => raw.prepare('SELECT device_id, kind, payload FROM sync_ops ORDER BY seq').all() as { device_id: string; kind: string; payload: string }[];

  beforeEach(async () => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    const bucket = fakeBucket();
    env = makeEnv(fresh.db, undefined, bucket);
    insertProfile(raw, 'p1', 'amanda');
    raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run('p1');
    await bucket.put('backups/p1/dev1.zip', backupZip().buffer as ArrayBuffer);
    // Sync is on: the phone has used the relay.
    const t = new Date().toISOString();
    raw.prepare('INSERT INTO devices (profile_id, device, name, platform, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run('p1', 'dev1', 'iPhone', 'ios', t, t);
  });

  it('read tools say read-only; write tools do not, and un-marking says destructive', () => {
    const all = tools();
    for (const n of ['search_library', 'watch_history', 'show_progress', 'stats', 'ratings', 'lists']) expect(all[n]!.annotations).toMatchObject({ readOnlyHint: true });
    for (const n of ['mark_episode_watched', 'mark_movie_watched', 'rate', 'add_to_watchlist', 'set_episode_feeling']) {
      expect(all[n]!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
    expect(all.unmark_episode_watched!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('a write lands in the relay as the assistant, the phone pulls it, and the next read sees it', async () => {
    const r = await run('mark_episode_watched', { show: 'Dark', season: 1, episode: 1, watched_at: '2026-11-01' });
    expect(r.error).toBe(false);
    expect(r.text).toContain('Marked Dark S1E1 watched on 2026-11-01.');
    expect(r.text).toContain(LANDS);
    expect(relayed()).toEqual([{ device_id: 'assistant', kind: 'watch', payload: '{"show":300,"s":1,"e":1,"at":"2026-11-01 12:00:00"}' }]);

    // Not a device: the five places are untouched.
    expect(raw.prepare('SELECT device FROM devices').all()).toEqual([{ device: 'dev1' }]);

    // The phone hears it on its next sync, in its own vocabulary.
    const pulled = await call(env, 'POST', '/v1/sync', { token: await tokenFor(env, 'p1'), body: { device: 'dev1', cursor: 0, ops: [] } });
    expect(pulled.json.ops).toMatchObject([{ kind: 'watch', payload: '{"show":300,"s":1,"e":1,"at":"2026-11-01 12:00:00"}' }]);

    const read = JSON.parse((await run('show_progress', { title: 'dark' })).text);
    expect(read).toMatchObject({ changesSince: 1, episodesWatched: 1 });
    // And doing it twice is refused, because the fresh read already has it.
    expect((await run('mark_episode_watched', { show: 'Dark', season: 1, episode: 1 })).text).toMatch(/already marked watched/);
  });

  it('refuses without the write scope, without Plus, and without Sync — and relays nothing', async () => {
    expect(await run('rate', { title: 'Dune', stars: 4 }, false)).toEqual({ text: NO_WRITE_SCOPE, error: true });

    raw.prepare('DELETE FROM devices').run();
    expect(await run('rate', { title: 'Inception', stars: 4 })).toEqual({ text: NO_SYNC, error: true });
    // A removed phone is not Sync either.
    const t = new Date().toISOString();
    raw.prepare("INSERT INTO devices (profile_id, device, first_seen, last_seen, removed_at) VALUES ('p1', 'dev1', ?, ?, ?)").run(t, t, t);
    expect((await run('rate', { title: 'Inception', stars: 4 })).text).toBe(NO_SYNC);
    expect(NO_SYNC).toContain('Settings → Library → Backup');

    raw.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ?').run('p1');
    expect((await run('rate', { title: 'Inception', stars: 4 })).text).toMatch(/does not include the Claude and ChatGPT connection/);
    expect((await run('lists', {})).text).toMatch(/does not include the Claude and ChatGPT connection/);
    expect(relayed()).toEqual([]);
  });

  it('counts each call by tool and assistant, and never what was asked', async () => {
    await run('search_library', { query: 'Breaking Bad' });
    await run('search_library', { query: 'Pokémon' });
    await run('rate', { title: 'Inception', stars: 4.5 });
    const rows = raw.prepare('SELECT * FROM mcp_calls ORDER BY tool').all() as Record<string, unknown>[];
    const today = new Date().toISOString().slice(0, 10);
    expect(rows).toEqual([
      { profile_id: 'p1', day: today, tool: 'rate', client: 'Claude', n: 1 },
      { profile_id: 'p1', day: today, tool: 'search_library', client: 'Claude', n: 2 },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/Breaking|Pok|Inception|4\.5/);
  });

  it('keeps 500 days per member', async () => {
    raw.prepare("INSERT INTO mcp_calls VALUES ('p1', '2020-01-01', 'stats', 'Claude', 3)").run();
    await countCall(env, 'p1', 'stats', 'Claude', '2026-11-04');
    expect(raw.prepare('SELECT day, n FROM mcp_calls').all()).toEqual([{ day: '2026-11-04', n: 1 }]);
  });

  it('names the assistant from its client, and nothing else', () => {
    expect(clientLabel('Claude')).toBe('Claude');
    expect(clientLabel('https://chatgpt.com/connector_platform_oauth_redirect')).toBe('ChatGPT');
    expect(clientLabel('OpenAI')).toBe('ChatGPT');
    expect(clientLabel('My <b>bot</b>')).toBe('Other');
    expect(clientLabel(undefined)).toBe('Other');
  });

  it('new connections are granted mcp:write', () => {
    expect(MCP_SCOPES).toContain('mcp:write');
  });

  it('the dashboard card: users by window, calls by tool and client, and who also opened the app', async () => {
    env = { ...env, ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' };
    insertProfile(raw, 'p2', 'sara');
    const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
    const put = raw.prepare('INSERT INTO mcp_calls VALUES (?, ?, ?, ?, ?)');
    put.run('p1', day(0), 'stats', 'Claude', 2);
    put.run('p1', day(3), 'rate', 'Claude', 1);
    put.run('p2', day(10), 'stats', 'ChatGPT', 4);
    put.run('p2', day(40), 'stats', 'ChatGPT', 9);
    raw.prepare('INSERT INTO profile_days (profile_id, day) VALUES (?, ?)').run('p1', day(1));
    const login = await call(env, 'POST', '/v1/admin/login', { body: { email: 'me@example.com', password: 'a-long-one' } });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await call(env, 'GET', '/v1/admin/mcp')).status).toBe(401);
    const res = await call(env, 'GET', '/v1/admin/mcp', { headers: { Cookie: cookie } });
    expect(res.json).toEqual({
      today: 1,
      week: 1,
      month: 2,
      alsoOpenedApp: 1,
      byTool: [
        { k: 'stats', n: 6 },
        { k: 'rate', n: 1 },
      ],
      byClient: [
        { k: 'ChatGPT', n: 4 },
        { k: 'Claude', n: 3 },
      ],
    });
  });

  it('deleting the account deletes its counts', async () => {
    await countCall(env, 'p1', 'stats', 'Claude');
    expect((await call(env, 'DELETE', '/v1/me', { token: await tokenFor(env, 'p1') })).status).toBe(204);
    expect(raw.prepare('SELECT * FROM mcp_calls').all()).toEqual([]);
  });
});
