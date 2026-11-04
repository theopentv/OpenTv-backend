import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

/**
 * The library behind the ChatGPT and Claude directory reviewers' demo account.
 *
 *   npx tsx scripts/make-review-backup.ts [out.zip]     (default review-backup.zip)
 *
 * INVENTED, ALL OF IT. Well-known shows under their real TheTVDB ids (taken
 * from the app's bundled `mobile/src/data/metadata.json`) and well-known films,
 * with dates, ratings and feelings made up here. Nothing is copied from any
 * member's library.
 *
 * THE SHAPE IS THE PHONE'S: what `buildTvTimeZip({ notes: false, images: false })`
 * in `mobile/src/exporter.ts` writes — TV Time's CSV names and headers, plus
 * the `_opentv_extras.json` sidecar with ratings out of ten. Only the files
 * that carry something are written; every reader treats a missing file as
 * empty, as it must for real exports.
 *
 * Upload it as the review account's backup (`backups/<profileId>/<device>.zip`)
 * and set the object's metadata from the counts this prints.
 */

type Cell = string | number | null | undefined;

// The columns `exporter.ts` writes, in TV Time's order (`mobile/src/tvtime-headers.ts`).
const HEADERS: Record<string, string[]> = {
  'routing-prod-users.csv': ['username', 'image_url', 'aws_region', 'created_at', 'updated_at', 'user_id'],
  'user_tv_show_data.csv': ['is_followed', 'is_favorited', 'nb_episodes_seen', 'tv_show_name', 'user_id', 'tv_show_id'],
  'followed_tv_show.csv': ['created_at', 'active', 'diffusion', 'notification_type', 'archived', 'tv_show_name', 'user_id', 'tv_show_id', 'notification_offset', 'updated_at', 'folder_id'],
  'tracking-prod-records-v2.csv': ['s_no', 'ep_no', 'runtime', 'series_name', 'episode_number', 'created_at', 'user_id', 'ep_id', 'key', 'season_number', 'gsi', 's_id', 'episode_id', 'updated_at', 'total_movies_runtime', 'series_follow_count', 'total_series_runtime', 'ep_watch_count', 'movie_watch_count', 'is_archived', 'is_for_later', 'uuid', 'is_followed', 'followed_at', 'most_recent_ep_watched', 'is_unitary', 'bulk_type', 'rewatch_count'],
  'tracking-prod-records.csv': ['type', 'series_id', 'watch_count', 'user_id', 'type-uuid-n', 'updated_at', 'created_at', 'uuid', 'series_name', 'watches', 'runtime', 'alpha_range_key', 'release_date', 'entity_type', 'movie_name', 'follow_date_range_key', 'release_date_range_key', 'episode_number', 'watch_date', 'season_number', 'episode_id', 'series_uuid', 'rewatch_count', 'total_series_runtime', 'total_movies_runtime', 'watch_date_range_key', 'country', 'bulk_type', 'watched_episode_range_key', 'unitarian'],
  'ratings-3-prod-episode_votes.csv': ['episode_id', 'vote_key', 'series_name', 'season_number', 'episode_number', 'user_id'],
  'emotions-3-prod-episode_votes.csv': ['episode_id', 'vote_key', 'user_id', 'series_name', 'season_number', 'episode_number'],
  'ratings-live-votes.csv': ['uuid', 'vote_key', 'episode_id', 'movie_name', 'user_id'],
  'tv_show_user_emotion_count.csv': ['tv_show_id', 'user_id', 'emotion_id', 'count', 'created_at', 'updated_at', 'tv_show_name'],
  'lists-prod-lists.csv': ['user_id', 'type', 'is_public', 'name', 'description', 's_key', 'ordering', 'created_at', 'objects', 'lists'],
  'user_statistics.csv': ['nb_comments', 'nb_reviews', 'nb_likes', 'score', 'user_id', 'time_spent', 'nb_friends', 'nb_memes', 'id', 'updated_at', 'created_at', 'nb_shows_followed', 'nb_episodes_watched'],
};

const UID = '0';

type ShowSpec = {
  id: number;
  name: string;
  runtime: number;
  favourite?: boolean;
  archived?: boolean;
  /** [season, episodes watched from 1, first day, days between episodes] */
  runs: [number, number, string, number][];
};

const SHOWS: ShowSpec[] = [
  { id: 81189, name: 'Breaking Bad', runtime: 47, favourite: true, runs: [[1, 7, '2025-01-06', 2], [2, 6, '2025-02-03', 3]] },
  { id: 273181, name: 'Better Call Saul', runtime: 46, archived: true, runs: [[1, 5, '2025-04-12', 4]] },
  { id: 305288, name: 'Stranger Things', runtime: 50, favourite: true, runs: [[1, 8, '2025-07-04', 1]] },
  { id: 334824, name: 'Dark', runtime: 55, runs: [[1, 10, '2025-10-01', 2]] },
  { id: 371028, name: 'Arcane', runtime: 40, favourite: true, runs: [[1, 9, '2025-11-21', 1]] },
  { id: 360893, name: 'Chernobyl', runtime: 65, runs: [[1, 5, '2026-02-09', 3]] },
  { id: 392256, name: 'The Last of Us', runtime: 55, runs: [[1, 9, '2026-03-02', 4], [2, 3, '2026-06-14', 7]] },
  { id: 397060, name: 'Wednesday', runtime: 50, runs: [] }, // followed, not started
];

type FilmSpec = { name: string; year: string; runtime: number; watched?: string; added?: string; ten?: number; rewatches?: number; favourite?: boolean };

const FILMS: FilmSpec[] = [
  { name: 'Inception', year: '2010', runtime: 148, watched: '2025-01-18 21:30:00', ten: 9 },
  { name: 'Interstellar', year: '2014', runtime: 169, watched: '2025-03-22 20:00:00', ten: 10, rewatches: 1, favourite: true },
  { name: 'Parasite', year: '2019', runtime: 132, watched: '2025-05-10 21:00:00', ten: 9 },
  { name: 'Spirited Away', year: '2001', runtime: 125, watched: '2025-08-16 18:30:00', ten: 8, favourite: true },
  { name: 'The Dark Knight', year: '2008', runtime: 152, watched: '2025-12-27 20:45:00', ten: 9 },
  { name: 'Everything Everywhere All at Once', year: '2022', runtime: 139, watched: '2026-01-24 21:15:00' },
  { name: 'Dune: Part Two', year: '2024', runtime: 166, watched: '2026-04-18 19:30:00', ten: 8 },
  { name: 'Oppenheimer', year: '2023', runtime: 180, added: '2025-09-02 12:00:00' },
  { name: 'Past Lives', year: '2023', runtime: 106, added: '2026-02-20 09:10:00' },
  { name: 'Arrival', year: '2016', runtime: 116, added: '2026-07-05 16:40:00' },
];

/** Out of ten, as the phone stores them since 2.0.0. */
const EPISODE_RATINGS: [number, number, number, number][] = [
  [81189, 1, 7, 9],
  [305288, 1, 8, 7],
  [334824, 1, 10, 10],
  [371028, 1, 9, 9],
  [360893, 1, 5, 10],
  [392256, 1, 3, 10],
];

/** [show, season, episode, index into the phone's twelve feelings (`FEELINGS` in library.ts)] */
const FEELINGS: [number, number, number, number][] = [
  [81189, 1, 7, 0], // shocked
  [334824, 1, 10, 10], // confused
  [360893, 1, 1, 11], // tense
  [392256, 1, 3, 4], // touched
];

const CUSTOM_LIST = { name: 'Weekend picks', shows: [334824, 360893], films: ['Arrival', 'Past Lives'] };

function csv(name: string, rows: Record<string, Cell>[]): Uint8Array {
  const header = HEADERS[name]!;
  const esc = (v: Cell) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return strToU8([header, ...rows.map((r) => header.map((h) => r[h]))].map((r) => r.map(esc).join(',')).join('\n') + '\n');
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/** Out of ten → TV Time's 0..3, half up, as `exporter.ts` does it. */
const tvtimeVote = (ten: number) => [0, 0, 1, 1, 2, 3][Math.min(5, Math.max(1, Math.round(ten / 2)))]!;

/** The counts are the R2 object's metadata keys (`toMetadata` in routes/backup.ts),
 *  counted as the phone counts them: `movies` is every film row, watchlist included. */
export function buildReviewBackup(): { zip: Uint8Array; counts: { shows: number; episodes: number; movies: number; filmsWatched: number } } {
  const watches = SHOWS.flatMap((s) =>
    s.runs.flatMap(([season, n, first, gap]) =>
      Array.from({ length: n }, (_, i) => ({
        show: s,
        season,
        episode: i + 1,
        // Evenings, a little apart, so the history reads like a person's.
        at: `${addDays(first, i * gap)} ${String(20 + (i % 3)).padStart(2, '0')}:${i % 2 ? '45' : '10'}:00`,
      })),
    ),
  );
  const seen = (id: number) => watches.filter((w) => w.show.id === id).length;
  const nameOf = new Map(SHOWS.map((s) => [s.id, s.name]));
  const uuid = new Map(FILMS.map((f, i) => [f.name, `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
  const emotionCount = new Map<string, number>();
  for (const [show, , , e] of FEELINGS) emotionCount.set(`${show}:${e}`, (emotionCount.get(`${show}:${e}`) ?? 0) + 1);

  const files: Record<string, Uint8Array> = {
    'routing-prod-users.csv': csv('routing-prod-users.csv', [{ username: 'opentv-review', image_url: '', user_id: UID }]),
    'user_tv_show_data.csv': csv(
      'user_tv_show_data.csv',
      SHOWS.map((s) => ({ is_followed: 1, is_favorited: s.favourite ? 1 : 0, nb_episodes_seen: seen(s.id), tv_show_name: s.name, user_id: UID, tv_show_id: s.id })),
    ),
    'followed_tv_show.csv': csv(
      'followed_tv_show.csv',
      SHOWS.map((s) => ({ active: s.archived ? 0 : 1, archived: s.archived ? 1 : 0, tv_show_name: s.name, user_id: UID, tv_show_id: s.id })),
    ),
    'tracking-prod-records-v2.csv': csv(
      'tracking-prod-records-v2.csv',
      watches.map((w) => ({
        s_id: w.show.id,
        series_name: w.show.name,
        season_number: w.season,
        episode_number: w.episode,
        created_at: w.at,
        runtime: w.show.runtime,
        rewatch_count: 0,
        user_id: UID,
      })),
    ),
    'tracking-prod-records.csv': csv(
      'tracking-prod-records.csv',
      FILMS.map((f) => ({
        type: f.watched ? 'watch' : 'towatch',
        entity_type: 'movie',
        movie_name: f.name,
        created_at: f.watched ?? f.added ?? '',
        runtime: f.runtime,
        rewatch_count: f.rewatches ?? 0,
        uuid: uuid.get(f.name),
        user_id: UID,
      })),
    ),
    'ratings-3-prod-episode_votes.csv': csv(
      'ratings-3-prod-episode_votes.csv',
      EPISODE_RATINGS.map(([show, s, e, ten]) => ({ vote_key: `0-${UID}-${tvtimeVote(ten)}`, series_name: nameOf.get(show), season_number: s, episode_number: e, user_id: UID })),
    ),
    'emotions-3-prod-episode_votes.csv': csv(
      'emotions-3-prod-episode_votes.csv',
      FEELINGS.map(([show, s, e, emotion]) => ({ vote_key: `0-${UID}-${emotion + 28}`, series_name: nameOf.get(show), season_number: s, episode_number: e, user_id: UID })),
    ),
    'tv_show_user_emotion_count.csv': csv(
      'tv_show_user_emotion_count.csv',
      [...emotionCount].map(([key, count]) => {
        const [show, emotion] = key.split(':').map(Number) as [number, number];
        return { tv_show_id: show, tv_show_name: nameOf.get(show), emotion_id: emotion + 28, count, user_id: UID };
      }),
    ),
    'ratings-live-votes.csv': csv(
      'ratings-live-votes.csv',
      FILMS.filter((f) => f.ten).map((f) => ({ vote_key: `0-${UID}-${tvtimeVote(f.ten!)}`, episode_id: '0', movie_name: f.name, user_id: UID })),
    ),
    'lists-prod-lists.csv': csv('lists-prod-lists.csv', [
      {
        user_id: UID,
        type: 'list',
        is_public: 'false',
        s_key: 'favorite-series',
        ordering: '0',
        objects: `[${SHOWS.filter((s) => s.favourite).map((s) => `map[id:${s.id} type:series]`).join(' ')}]`,
      },
      {
        user_id: UID,
        type: 'list',
        is_public: 'false',
        s_key: 'favorite-movies',
        ordering: '0',
        objects: `[${FILMS.filter((f) => f.favourite).map((f) => `map[type:movie uuid:${uuid.get(f.name)}]`).join(' ')}]`,
      },
      {
        user_id: UID,
        type: 'list',
        is_public: 'true',
        name: CUSTOM_LIST.name,
        s_key: 'custom-1',
        ordering: '1',
        created_at: '2026-02-20 09:12:00',
        objects: `[${[
          ...CUSTOM_LIST.shows.map((id) => `map[id:${id} type:series]`),
          ...CUSTOM_LIST.films.map((n) => `map[type:movie uuid:${uuid.get(n)}]`),
        ].join(' ')}]`,
      },
    ]),
    'user_statistics.csv': csv('user_statistics.csv', [
      { nb_comments: 0, nb_likes: 0, nb_friends: 0, nb_shows_followed: SHOWS.length, nb_episodes_watched: watches.length, user_id: UID },
    ]),
    '_opentv_extras.json': strToU8(
      JSON.stringify({
        movies: FILMS.map((f) => ({ name: f.name, tmdbId: null, poster: null, year: f.year, watchedOn: null, stars: f.ten ?? null, rewatchCount: f.rewatches ?? null })),
        shows: SHOWS.map((s) => ({
          tvdbId: s.id,
          posterUrl: null,
          addedAt: null,
          finished: 0,
          tmdbId: null,
          posterOverride: null,
          backdropOverride: null,
        })),
        epStars: EPISODE_RATINGS.map(([showId, season, episode, stars]) => ({ showId, season, episode, stars })),
        epWatchedOn: [],
        epCharVotes: [],
        profile: { avatarFile: null, coverFile: null },
        commentImages: [],
        socialImages: [],
        imageFiles: [],
        movieScale: 10,
        puzzle: { history: null, archive: null },
        epScale: 10,
      }),
    ),
  };

  return {
    zip: zipSync(files, { level: 6 }),
    counts: { shows: SHOWS.length, episodes: watches.length, movies: FILMS.length, filmsWatched: FILMS.filter((f) => f.watched).length },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] ?? 'review-backup.zip';
  const { zip, counts } = buildReviewBackup();
  writeFileSync(out, zip);
  console.log(`wrote ${out} (${zip.length} bytes)`);
  console.log(`${counts.shows} shows, ${counts.episodes} episodes, ${counts.movies} films (${counts.filmsWatched} watched)`);
  console.log(`R2 customMetadata: username=opentv-review shows=${counts.shows} episodes=${counts.episodes} movies=${counts.movies}`);
}
