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
 * A member's library, read out of their own backup ZIP — and the six questions
 * the MCP server can ask of it.
 *
 * PURE ON PURPOSE. Nothing here touches R2, D1, KV or the MCP SDK: bytes in,
 * plain objects out. That is what lets the whole of "what does Claude get told"
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
