import { strFromU8 } from 'fflate';
import {
  exportReader,
  listEntries,
  movieNamesByUuid,
  readEpisodeRatings,
  readEpisodeWatches,
  readFavorites,
  readMovieRatings,
  readMovies,
  readShows,
  unzipExport,
} from '@/tvtime-export';

/**
 * A member's library, read out of their own backup ZIP — the six questions
 * the MCP server can ask of it, the relay ops that bring it up to now, and the
 * changes the write tools turn into ops.
 *
 * PURE ON PURPOSE. Nothing here touches R2, D1, KV or the MCP SDK: bytes and
 * ops in, plain objects out. That is what lets the whole of "what does Claude get told"
 * be tested against a ZIP built in the test, with no Worker and no OAuth in the
 * way — and it is what keeps the rule honest that nothing derived is STORED.
 * `server.ts` holds the parsed result in memory for as long as the isolate
 * lives and the backup has not changed, and that is the only copy there is.
 *
 * WHAT IS NOT HERE, AND WHY. Private notes: the server copy of a backup is
 * built without them (`buildTvTimeZip({ notes: false })` in the app's
 * `cloud-backup.ts`), so
 * there is nothing to find and nothing to look for. Comments, emotions and
 * favourite characters are in the ZIP but no tool asks for them yet; they are
 * one reader away when somebody wants them.
 *
 * RATINGS ARE ANSWERED ON ONE SCALE: 1 to 5 stars, halves allowed. OpenTV has
 * rated out of ten since 2.0.0 (the sidecar says so with `movieScale` /
 * `epScale`), TV Time's CSVs only ever held whole stars, and a model handed
 * "8" with no scale will guess. Halving the out-of-ten value is exactly the
 * star row the app draws, so what Claude says matches what the phone shows.
 */

export type Show = { id: number; name: string; followed: boolean; favourite: boolean; archived: boolean };
export type Watch = { showId: number; season: number; episode: number; at: string; runtime: number | null };
export type Film = {
  name: string;
  /** the LATEST watch — the backup keeps one date per film plus a rewatch count */
  watchedAt: string | null;
  addedAt: string | null;
  runtime: number | null;
  rewatches: number;
  year: string | null;
  stars: number | null;
  favourite: boolean;
};
export type EpisodeRating = { showId: number; season: number; episode: number; stars: number };
export type UserList = { name: string; items: string[]; unnamedFilms: number };

export type Library = {
  shows: Show[];
  watches: Watch[];
  films: Film[];
  episodeRatings: EpisodeRating[];
  lists: UserList[];
  /** indexes, built once at parse time */
  showById: Map<number, Show>;
  watchesByShow: Map<number, Watch[]>;
};

/** The sidecar `exporter.ts` writes beside the CSVs. Every field optional:
 *  older backups predate most of them. */
type Extras = {
  movies?: { name?: string; stars?: number | null; year?: string | null }[];
  epStars?: { showId?: number; season?: number; episode?: number; stars?: number }[];
  movieScale?: number;
  epScale?: number;
};

export const RATING_SCALE = '1-5 stars, halves allowed (OpenTV rates out of ten; shown here halved, as the app draws it)';

/** Case-, accent- and punctuation-blind, for matching a title somebody typed. */
export const fold = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** `2021-05-21 12:25:23` and `2021-05-21T12:25:23.000Z` both appear; one sortable shape. */
const stamp = (s: string | null | undefined): string => (s ?? '').replace('T', ' ').slice(0, 19);
const day = (s: string): string => s.slice(0, 10);
const half = (v: number): number => Math.round(v * 2) / 2;

export function parseLibrary(zip: Uint8Array): Library {
  const files = unzipExport(zip);
  const { csv } = exportReader(files);

  let extras: Extras = {};
  const extrasKey = Object.keys(files).find((k) => k.endsWith('_opentv_extras.json'));
  if (extrasKey) {
    try {
      extras = JSON.parse(strFromU8(files[extrasKey]!)) as Extras;
    } catch {
      // A broken sidecar costs the exact ratings, never the library: the CSVs
      // still carry whole stars.
    }
  }

  const listRows = csv('lists-prod-lists.csv');
  const v1 = csv('tracking-prod-records.csv');
  const v2 = csv('tracking-prod-records-v2.csv');
  const uuidToFilm = movieNamesByUuid(v1);
  const favs = readFavorites(listRows, uuidToFilm);
  const favShows = new Set(favs.showIds);
  const favFilms = new Set(favs.movieNames);

  const shows: Show[] = readShows(csv('user_tv_show_data.csv'), csv('followed_tv_show.csv')).map((s) => ({
    id: s.tvdbId,
    name: s.name ?? '',
    followed: s.followed,
    favourite: s.favorited || favShows.has(s.tvdbId),
    archived: s.archived,
  }));
  const showById = new Map(shows.map((s) => [s.id, s]));

  // v2 only. OpenTV's own exporter never writes episode rows to the legacy
  // file, and this only ever reads OpenTV's own backups.
  const watches: Watch[] = readEpisodeWatches(v2).map((w) => ({
    showId: w.showId,
    season: w.season,
    episode: w.episode,
    at: stamp(w.watchedAt),
    runtime: w.runtime && w.runtime > 0 ? w.runtime : null,
  }));
  const watchesByShow = new Map<number, Watch[]>();
  for (const w of watches) {
    const list = watchesByShow.get(w.showId);
    if (list) list.push(w);
    else watchesByShow.set(w.showId, [w]);
  }

  // Film ratings: the sidecar's exact value when it has one, the CSV's whole
  // star otherwise.
  const filmScale = extras.movieScale === 10 ? 2 : 1;
  const filmStars = new Map<string, number>();
  for (const r of readMovieRatings(csv('ratings-live-votes.csv'))) filmStars.set(r.name, r.stars);
  for (const m of extras.movies ?? []) {
    if (m.name && typeof m.stars === 'number' && m.stars > 0) filmStars.set(m.name, half(m.stars / filmScale));
  }
  const filmYear = new Map((extras.movies ?? []).filter((m) => m.name && m.year).map((m) => [m.name!, m.year!]));
  const films: Film[] = readMovies(v1).movies.map((m) => ({
    name: m.name,
    watchedAt: m.watchedAt ? stamp(m.watchedAt) : null,
    addedAt: m.addedAt ? stamp(m.addedAt) : null,
    runtime: m.runtime && m.runtime > 0 ? m.runtime : null,
    rewatches: m.rewatches,
    year: m.year ?? filmYear.get(m.name) ?? null,
    stars: filmStars.get(m.name) ?? null,
    favourite: favFilms.has(m.name),
  }));

  // Episode ratings: the sidecar carries show ids and the exact value; the CSV
  // names the show and has to be matched back by name.
  let episodeRatings: EpisodeRating[];
  if (Array.isArray(extras.epStars)) {
    const scale = extras.epScale === 10 ? 2 : 1;
    episodeRatings = extras.epStars
      .filter((r) => typeof r.showId === 'number' && typeof r.stars === 'number' && r.stars > 0)
      .map((r) => ({ showId: r.showId!, season: r.season ?? 0, episode: r.episode ?? 0, stars: half(r.stars! / scale) }));
  } else {
    const idByName = new Map<string, number>();
    for (const s of shows) idByName.set(fold(s.name), s.id);
    for (const r of v2) if (r.series_name && r.s_id) idByName.set(fold(r.series_name), Number(r.s_id));
    episodeRatings = readEpisodeRatings(csv('ratings-3-prod-episode_votes.csv')).flatMap((r) => {
      const showId = idByName.get(fold(r.name));
      return showId ? [{ showId, season: r.season, episode: r.episode, stars: r.stars }] : [];
    });
  }

  const lists: UserList[] = listRows
    .filter((r) => r.type === 'list' && !/^favorite-/.test(r.s_key ?? ''))
    .map((r) => {
      const items: string[] = [];
      let unnamedFilms = 0;
      for (const e of listEntries(r.objects)) {
        const name = e.kind === 'show' ? showById.get(e.tvdbId)?.name : e.uuid ? uuidToFilm.get(e.uuid) : undefined;
        if (name) items.push(name);
        else if (e.kind === 'movie') unnamedFilms++;
      }
      return { name: (r.name ?? '').trim() || 'Untitled list', items, unnamedFilms };
    });

  return { shows, watches, films, episodeRatings, lists, showById, watchesByShow };
}

// ── the tools' answers ───────────────────────────────────────────────────────
//
// Each returns a small plain object the server stringifies. CAPPED, every one:
// a library is tens of thousands of rows and a model's context is not the place
// to put them. A cap always reports how many it left out, so "200 shown" is
// never mistaken for "200 exist".

const rank = (name: string, q: string): number => {
  const f = fold(name);
  return f === q ? 0 : f.startsWith(q) ? 1 : f.includes(q) ? 2 : -1;
};

function matches<T>(items: T[], name: (t: T) => string, query: string): T[] {
  const q = fold(query);
  if (!q) return [];
  return items
    .map((t) => ({ t, r: rank(name(t), q) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.t);
}

function showSummary(lib: Library, s: Show) {
  const ws = lib.watchesByShow.get(s.id) ?? [];
  const dated = ws.map((w) => w.at).filter(Boolean).sort();
  const rated = lib.episodeRatings.filter((r) => r.showId === s.id);
  return {
    title: s.name,
    episodesWatched: new Set(ws.map((w) => `${w.season}x${w.episode}`)).size,
    watchesIncludingRewatches: ws.length,
    firstWatched: dated.length ? day(dated[0]!) : null,
    lastWatched: dated.length ? day(dated[dated.length - 1]!) : null,
    favourite: s.favourite,
    followed: s.followed,
    archived: s.archived,
    averageEpisodeRating: rated.length ? half(rated.reduce((n, r) => n + r.stars, 0) / rated.length) : null,
    episodesRated: rated.length,
  };
}

function filmSummary(f: Film) {
  return {
    title: f.name,
    year: f.year,
    watched: f.watchedAt !== null,
    lastWatched: f.watchedAt ? day(f.watchedAt) || null : null,
    rewatches: f.rewatches,
    rating: f.stars,
    onWatchlist: f.watchedAt === null,
    favourite: f.favourite,
  };
}

export function searchLibrary(lib: Library, query: string, cap = 15) {
  const shows = matches(lib.shows, (s) => s.name, query);
  const films = matches(lib.films, (f) => f.name, query);
  return {
    ratingScale: RATING_SCALE,
    shows: shows.slice(0, cap).map((s) => showSummary(lib, s)),
    films: films.slice(0, cap).map(filmSummary),
    ...(shows.length > cap || films.length > cap
      ? { more: { shows: Math.max(0, shows.length - cap), films: Math.max(0, films.length - cap) } }
      : {}),
    note: 'Films keep only the latest watch date plus a rewatch count.',
  };
}

export type Kind = 'episodes' | 'films' | 'all';

/** `from` and `to` are inclusive calendar days, YYYY-MM-DD. */
export function watchHistory(lib: Library, from: string, to: string, kind: Kind = 'all', cap = 200) {
  const inRange = (at: string) => !!at && day(at) >= from && day(at) <= to;
  type Row = { date: string; at: string; type: 'episode' | 'film'; title: string; season?: number; episode?: number };
  const rows: Row[] = [];
  if (kind !== 'films') {
    for (const w of lib.watches) {
      if (!inRange(w.at)) continue;
      rows.push({ date: day(w.at), at: w.at, type: 'episode', title: lib.showById.get(w.showId)?.name ?? `Show ${w.showId}`, season: w.season, episode: w.episode });
    }
  }
  if (kind !== 'episodes') {
    for (const f of lib.films) if (f.watchedAt && inRange(f.watchedAt)) rows.push({ date: day(f.watchedAt), at: f.watchedAt, type: 'film', title: f.name });
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));
  return {
    from,
    to,
    total: rows.length,
    items: rows.slice(0, cap).map(({ at: _at, ...r }) => r),
    ...(rows.length > cap ? { more: rows.length - cap } : {}),
    note: 'Films appear on their latest watch date only.',
  };
}

export function showProgress(lib: Library, title: string) {
  const found = matches(lib.shows, (s) => s.name, title);
  const s = found[0];
  if (!s) return { found: false, title };
  const ws = lib.watchesByShow.get(s.id) ?? [];
  const seasons = new Map<number, Watch[]>();
  for (const w of ws) {
    const list = seasons.get(w.season);
    if (list) list.push(w);
    else seasons.set(w.season, [w]);
  }
  return {
    found: true,
    ...showSummary(lib, s),
    seasons: [...seasons.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([season, list]) => {
        const last = list.reduce((a, b) => (b.at > a.at ? b : a));
        return {
          season,
          episodesWatched: new Set(list.map((w) => w.episode)).size,
          lastWatched: last.at ? day(last.at) : null,
          lastEpisode: last.episode,
        };
      }),
    ...(found.length > 1 ? { otherMatches: found.slice(1, 6).map((x) => x.name) } : {}),
  };
}

function distribution(values: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values.sort((a, b) => a - b)) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function stats(lib: Library, year?: number) {
  const y = year === undefined ? null : String(year);
  const inYear = (at: string | null) => (y === null ? true : !!at && at.startsWith(y));
  const eps = lib.watches.filter((w) => inYear(w.at));
  const films = lib.films.filter((f) => f.watchedAt !== null && inYear(f.watchedAt));
  const minutes = eps.reduce((n, w) => n + (w.runtime ?? 0), 0) + films.reduce((n, f) => n + (f.runtime ?? 0), 0);
  const perShow = new Map<number, number>();
  for (const w of eps) perShow.set(w.showId, (perShow.get(w.showId) ?? 0) + 1);
  return {
    period: y ?? 'all time',
    episodesWatched: eps.length,
    showsWatched: perShow.size,
    filmsWatched: films.length,
    hoursWatched: Math.round(minutes / 6) / 10,
    itemsWithoutRuntime: eps.filter((w) => w.runtime === null).length + films.filter((f) => f.runtime === null).length,
    topShows: [...perShow.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, n]) => ({ title: lib.showById.get(id)?.name ?? `Show ${id}`, episodes: n })),
    ratingScale: RATING_SCALE,
    // Ratings carry no date in the backup, so this is the same for every year.
    ratingDistributionAllTime: {
      episodes: distribution(lib.episodeRatings.map((r) => r.stars)),
      films: distribution(lib.films.flatMap((f) => (f.stars === null ? [] : [f.stars]))),
    },
    note: 'Episode counts include rewatches. Films count once, on their latest watch date. Hours cover only items with a known runtime.',
  };
}

export function ratings(lib: Library, kind: Kind = 'all', min = 0, max = 5, cap = 100) {
  type Row = { type: 'episode' | 'film'; title: string; season?: number; episode?: number; stars: number };
  const rows: Row[] = [];
  const ok = (v: number) => v >= min && v <= max;
  if (kind !== 'films') {
    for (const r of lib.episodeRatings) {
      if (ok(r.stars)) rows.push({ type: 'episode', title: lib.showById.get(r.showId)?.name ?? `Show ${r.showId}`, season: r.season, episode: r.episode, stars: r.stars });
    }
  }
  if (kind !== 'episodes') {
    for (const f of lib.films) if (f.stars !== null && ok(f.stars)) rows.push({ type: 'film', title: f.name, stars: f.stars });
  }
  rows.sort((a, b) => b.stars - a.stars || a.title.localeCompare(b.title) || (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
  return {
    ratingScale: RATING_SCALE,
    total: rows.length,
    items: rows.slice(0, cap),
    ...(rows.length > cap ? { more: rows.length - cap } : {}),
  };
}

export function lists(lib: Library, cap = 200) {
  const watchlist = lib.films.filter((f) => f.watchedAt === null).sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''));
  const notStarted = lib.shows.filter((s) => s.followed && !s.archived && !lib.watchesByShow.has(s.id));
  return {
    watchlistFilms: { total: watchlist.length, titles: watchlist.slice(0, cap).map((f) => f.name) },
    followedShowsNotStarted: { total: notStarted.length, titles: notStarted.slice(0, cap).map((s) => s.name) },
    favourites: {
      shows: lib.shows.filter((s) => s.favourite).map((s) => s.name),
      films: lib.films.filter((f) => f.favourite).map((f) => f.name),
    },
    lists: lib.lists.map((l) => ({
      name: l.name,
      total: l.items.length + l.unnamedFilms,
      items: l.items.slice(0, cap),
      // Films TV Time listed by an id alone, with no title anywhere in the export.
      ...(l.unnamedFilms ? { filmsWithoutATitle: l.unnamedFilms } : {}),
    })),
  };
}

// ── fresh reads: the relay ops newer than the backup ─────────────────────────
//
// The backup is the phone as it was at its last upload. Anything done since —
// on another device, or by the assistant a minute ago — is in `sync_ops`, in
// the phones' own vocabulary (`mobile/src/sync-ops.ts`). Replaying it here is
// what makes "mark it watched" followed by "what did I watch today?" agree.
//
// A COPY, never the cached library: `server.ts` keeps one parse per backup and
// every call starts from it. Kinds no read tool looks at (emotion, charVote,
// design, a newer build's) are skipped, exactly as an older phone skips them.

export type RelayOp = { ts: number; kind: string; payload: string };

const tsStamp = (ts: number): string => {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : stamp(d.toISOString());
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/** Out of ten (2.0.0+) or whole stars (1.7), as the phone's `parseOp` reads them; null = not a rating. */
const tenOf = (o: Record<string, unknown>): number | null => {
  if ('ten' in o) {
    const t = num(o.ten);
    return t !== null && t >= 1 && t <= 10 ? t : null;
  }
  const s = num(o.stars);
  return s !== null && s >= 1 && s <= 5 ? s * 2 : null;
};

export function applyOps(lib: Library, ops: readonly RelayOp[]): Library {
  if (ops.length === 0) return lib;
  const shows = new Map(lib.shows.map((s) => [s.id, { ...s }]));
  let watches = lib.watches.slice();
  let films = lib.films.map((f) => ({ ...f }));
  let epRatings = lib.episodeRatings.slice();
  const film = (name: string) => films.find((f) => f.name === name) ?? films.find((f) => f.name.toLowerCase() === name.toLowerCase());
  const sameEp = (show: number, s: number, e: number) => (w: { showId: number; season: number; episode: number }) =>
    w.showId === show && w.season === s && w.episode === e;
  const ensureShow = (id: number, name = '') => {
    if (!shows.has(id)) shows.set(id, { id, name: name || `Show ${id}`, followed: true, favourite: false, archived: false });
  };

  for (const op of [...ops].sort((a, b) => a.ts - b.ts)) {
    let o: Record<string, unknown>;
    try {
      const j: unknown = JSON.parse(op.payload);
      if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
      o = j as Record<string, unknown>;
    } catch {
      continue;
    }
    const show = num(o.show);
    const s = num(o.s);
    const e = num(o.e);
    const name = typeof o.name === 'string' && o.name ? o.name : null;
    const ep = show !== null && s !== null && e !== null;
    const at = tsStamp(op.ts);

    switch (op.kind) {
      case 'watch':
      case 'rewatch':
        if (!ep) break;
        ensureShow(show);
        watches.push({ showId: show, season: s, episode: e, at: (op.kind === 'watch' && typeof o.at === 'string' && stamp(o.at)) || at, runtime: null });
        break;
      case 'unwatch':
        if (ep) watches = watches.filter((w) => !sameEp(show, s, e)(w));
        break;
      case 'rate': {
        const ten = tenOf(o);
        if (!ep || ten === null) break;
        epRatings = epRatings.filter((r) => !sameEp(show, s, e)(r));
        epRatings.push({ showId: show, season: s, episode: e, stars: half(ten / 2) });
        break;
      }
      case 'unrate':
        if (ep) epRatings = epRatings.filter((r) => !sameEp(show, s, e)(r));
        break;
      case 'showAdd':
        if (show === null || show <= 0) break;
        ensureShow(show, name ?? '');
        if (name && shows.get(show)!.name === `Show ${show}`) shows.get(show)!.name = name;
        break;
      case 'showFlag': {
        const sh = show === null ? undefined : shows.get(show);
        if (!sh || typeof o.on !== 'boolean') break;
        if (o.flag === 'followed') sh.followed = o.on;
        else if (o.flag === 'favorited') sh.favourite = o.on;
        else if (o.flag === 'archived') sh.archived = o.on;
        break;
      }
      case 'showDelete':
        if (show === null) break;
        shows.delete(show);
        watches = watches.filter((w) => w.showId !== show);
        epRatings = epRatings.filter((r) => r.showId !== show);
        break;
      case 'movieAdd':
        if (name && !film(name)) {
          films.push({ name, watchedAt: null, addedAt: at, runtime: null, rewatches: 0, year: typeof o.year === 'string' ? o.year : null, stars: null, favourite: false });
        }
        break;
      case 'movieWatch': {
        const f = name ? film(name) : undefined;
        if (!f || typeof o.on !== 'boolean') break;
        f.watchedAt = o.on ? at : null;
        if (!o.on) f.rewatches = 0;
        break;
      }
      case 'movieRewatch': {
        const f = name ? film(name) : undefined;
        if (f) {
          f.rewatches += 1;
          f.watchedAt = at;
        }
        break;
      }
      case 'movieStars': {
        const f = name ? film(name) : undefined;
        if (!f) break;
        if (o.ten === null || (!('ten' in o) && o.stars === null)) f.stars = null;
        else {
          const ten = tenOf(o);
          if (ten !== null) f.stars = half(ten / 2);
        }
        break;
      }
      case 'movieDelete':
        if (name) films = films.filter((f) => f.name !== name);
        break;
    }
  }

  const showList = [...shows.values()];
  const watchesByShow = new Map<number, Watch[]>();
  for (const w of watches) {
    const list = watchesByShow.get(w.showId);
    if (list) list.push(w);
    else watchesByShow.set(w.showId, [w]);
  }
  return { ...lib, shows: showList, watches, films, episodeRatings: epRatings, showById: new Map(showList.map((s) => [s.id, s])), watchesByShow };
}

// ── writes: only ops the shipped phones already apply ────────────────────────
//
// Each plan reads the member's library (fresh, as above) to turn a title into
// the id or name the phone keys on, and returns either the ops to relay or a
// sentence saying why not. The shapes are `Action` in `mobile/src/sync-ops.ts`,
// field for field: `kind` is its `t`, `payload` the rest, as `makeOp` builds
// them. Nothing here invents a kind; something with no op type has no tool.
//
// What the server cannot do is look a title up anywhere: it holds no TheTVDB
// or TMDB client. So a SHOW must already be in the library (an op needs its
// TheTVDB id). A FILM is keyed by its title alone, so one not in the library
// can be added (`movieAdd`, the same op the phone sends from search, with no
// TMDB id — the phone fills the poster by title and year, as for an import).

export type OutOp = { kind: string; payload: string };
export type Plan = { ops: OutOp[]; done: string } | { refuse: string };

const out = (kind: string, body: Record<string, unknown>): OutOp => ({ kind, payload: JSON.stringify(body) });

/** TV Time's twelve, in the phone's order: the op carries the INDEX (episode/[id].tsx `EMOTIONS`). */
export const FEELINGS = ['shocked', 'frustrated', 'sad', 'reflective', 'touched', 'amused', 'scared', 'bored', 'understood', 'thrilled', 'confused', 'tense'] as const;

type Picked<T> = { hit: T } | { refuse: string };

/** One title: an exact (folded) match wins, a single partial match will do, several are asked about. */
function pickOne<T>(items: T[], name: (t: T) => string, query: string, what: string): Picked<T> | null {
  const q = fold(query);
  const exact = items.filter((t) => fold(name(t)) === q);
  if (exact.length >= 1) return { hit: exact[0]! };
  const found = matches(items, name, query);
  if (found.length === 1) return { hit: found[0]! };
  if (found.length > 1) {
    return { refuse: `Several ${what} in the library match "${query}": ${found.slice(0, 8).map(name).join('; ')}. Say which one, by its exact title.` };
  }
  return null;
}

function findShow(lib: Library, title: string): Picked<Show> {
  return (
    pickOne(lib.shows, (s) => s.name, title, 'shows') ?? {
      refuse: `"${title}" is not in this OpenTV library. A show has to be added in the app first (search for it in OpenTV), because the server cannot look shows up.`,
    }
  );
}

function findFilm(lib: Library, title: string, year?: string): Picked<Film> | null {
  const pool = year ? lib.films.filter((f) => !f.year || f.year.startsWith(year)) : lib.films;
  return pickOne(pool, (f) => f.name, title, 'films');
}

const epLabel = (s: Show, season: number, episode: number) => `${s.name} S${season}E${episode}`;

/** `YYYY-MM-DD` or a full time → the phone's `watchedAt` shape. A bare day is noon, so no time zone moves it a day. */
export function watchStamp(input: string | undefined, now = new Date()): string | null {
  if (!input) return stamp(now.toISOString());
  const t = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return isNaN(Date.parse(t)) ? null : `${t} 12:00:00`;
  const ms = Date.parse(t);
  return isNaN(ms) ? null : stamp(new Date(ms).toISOString());
}

export function planMarkEpisode(lib: Library, title: string, season: number, episode: number, watchedAt?: string, now = new Date()): Plan {
  const p = findShow(lib, title);
  if ('refuse' in p) return p;
  const at = watchStamp(watchedAt, now);
  if (!at) return { refuse: `"${watchedAt}" is not a date. Use YYYY-MM-DD.` };
  if (at.slice(0, 10) > stamp(new Date(now.getTime() + 864e5).toISOString()).slice(0, 10)) return { refuse: 'That date is in the future.' };
  const seen = (lib.watchesByShow.get(p.hit.id) ?? []).find((w) => w.season === season && w.episode === episode);
  if (seen) return { refuse: `${epLabel(p.hit, season, episode)} is already marked watched (${day(seen.at) || 'no date'}). Nothing was changed.` };
  return {
    ops: [out('watch', { show: p.hit.id, s: season, e: episode, at })],
    done: `Marked ${epLabel(p.hit, season, episode)} watched on ${at.slice(0, 10)}.`,
  };
}

export function planUnmarkEpisode(lib: Library, title: string, season: number, episode: number): Plan {
  const p = findShow(lib, title);
  if ('refuse' in p) return p;
  const seen = (lib.watchesByShow.get(p.hit.id) ?? []).some((w) => w.season === season && w.episode === episode);
  if (!seen) return { refuse: `${epLabel(p.hit, season, episode)} is not marked watched. Nothing was changed.` };
  return {
    ops: [out('unwatch', { show: p.hit.id, s: season, e: episode })],
    done: `Un-marked ${epLabel(p.hit, season, episode)}; every watch of it is removed.`,
  };
}

export function planMarkFilm(lib: Library, title: string, year?: string): Plan {
  const p = findFilm(lib, title, year);
  if (p && 'refuse' in p) return p;
  if (p) {
    if (p.hit.watchedAt) return { refuse: `${p.hit.name} is already marked watched (${day(p.hit.watchedAt)}). Nothing was changed.` };
    return { ops: [out('movieWatch', { name: p.hit.name, on: true })], done: `Marked ${p.hit.name} watched, dated today (OpenTV dates a film when it is marked).` };
  }
  // Not in the library: added first, then watched — two ops the phone applies in order.
  const name = title.trim();
  return {
    ops: [out('movieAdd', { name, poster: null, year: year ?? null, tmdbId: null }), out('movieWatch', { name, on: true })],
    done: `Added ${name}${year ? ` (${year})` : ''} to the library and marked it watched, dated today. It was not in the library before, so check the title is exactly right.`,
  };
}

/** Stars 0.5–5 in halves → out of ten 1–10, the scale both rating ops carry; plus the 1.7 whole star. */
export function starsToTen(stars: number): { ten: number; whole: number } | null {
  const ten = Math.round(stars * 2);
  if (!(ten >= 1 && ten <= 10) || Math.abs(stars * 2 - ten) > 1e-9) return null;
  return { ten, whole: Math.ceil(ten / 2) };
}

export function planRate(lib: Library, title: string, stars: number, season?: number, episode?: number, year?: string): Plan {
  const r = starsToTen(stars);
  if (!r) return { refuse: 'A rating is 0.5 to 5 stars, in halves.' };
  if ((season === undefined) !== (episode === undefined)) return { refuse: 'Give both a season and an episode to rate an episode, or neither to rate a film.' };
  if (season !== undefined && episode !== undefined) {
    const p = findShow(lib, title);
    if ('refuse' in p) return p;
    return {
      ops: [out('rate', { show: p.hit.id, s: season, e: episode, ten: r.ten, stars: r.whole })],
      done: `Rated ${epLabel(p.hit, season, episode)} ${stars} stars.`,
    };
  }
  const p = findFilm(lib, title, year);
  if (!p) return { refuse: `"${title}" is not a film in this OpenTV library, and a rating can only go on one that is. Mark it watched or add it to the watchlist first.` };
  if ('refuse' in p) return p;
  return { ops: [out('movieStars', { name: p.hit.name, ten: r.ten, stars: r.whole })], done: `Rated ${p.hit.name} ${stars} stars.` };
}

export function planWatchlist(lib: Library, title: string, kind: 'film' | 'show', year?: string): Plan {
  if (kind === 'show') {
    const p = findShow(lib, title);
    if ('refuse' in p) return p;
    if (p.hit.followed && !p.hit.archived) return { refuse: `${p.hit.name} is already followed in OpenTV. Nothing was changed.` };
    return { ops: [out('showFlag', { show: p.hit.id, flag: 'followed', on: true })], done: `Followed ${p.hit.name}, so it shows on the Shows tab.` };
  }
  const p = findFilm(lib, title, year);
  if (p && 'refuse' in p) return p;
  if (p) return { refuse: `${p.hit.name} is already in the library (${p.hit.watchedAt ? 'watched' : 'on the watchlist'}). Nothing was changed.` };
  const name = title.trim();
  return {
    ops: [out('movieAdd', { name, poster: null, year: year ?? null, tmdbId: null })],
    done: `Added ${name}${year ? ` (${year})` : ''} to the film watchlist. The phone finds its poster by title and year, so check the title is exactly right.`,
  };
}

export function planFeeling(lib: Library, title: string, season: number, episode: number, feeling: (typeof FEELINGS)[number], on: boolean): Plan {
  const p = findShow(lib, title);
  if ('refuse' in p) return p;
  return {
    ops: [out('emotion', { show: p.hit.id, s: season, e: episode, emotion: FEELINGS.indexOf(feeling), on })],
    done: `${on ? 'Set' : 'Took back'} "${feeling}" on ${epLabel(p.hit, season, episode)}.`,
  };
}
