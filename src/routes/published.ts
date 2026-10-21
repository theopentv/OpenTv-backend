import { Hono, type Context } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { hasPlus, requireAuth } from '@/middleware';
import {
  chunk,
  D1_MAX_BOUND_PARAMS,
  isTargetSource,
  listId,
  numberOrNull,
  plusOn,
  sectionHidden,
} from '@/pure';
import { optionalViewer } from '@/routes/comments';

/**
 * The published half of a profile: how much someone has watched, and what.
 *
 * WHY IT EXISTS. Another person's profile was a name, a follower count and a
 * shelf of lists, because the server held no history at all. The design
 * (design/referance/51-user-profile-sarah.png) is mostly history — TV time,
 * episodes watched, their shows, their films, their favourites — so those
 * shelves had nothing to draw.
 *
 * WHAT IS PUBLISHED IS A SUMMARY, NOT A HISTORY. There is deliberately no row
 * anywhere recording that a particular episode was watched on a particular
 * date: that is the thing that would let a reader reconstruct somebody's
 * evenings, and it stays on the phone. What goes up is two totals and a list of
 * titles — exactly what the shelves render and nothing more.
 *
 * IT IS DERIVED AND DISPOSABLE. The phone recomputes all of it from its own
 * database and replaces what is here. Nothing on this server is authoritative,
 * there is no reconciliation job, and losing the lot costs one sync.
 */

export const published = new Hono<App>();

/**
 * WHAT A FREE PROFILE MAY PUBLISH — the server half of OpenTV Plus.
 *
 * Enforced HERE rather than on the phone, because a cap the client alone
 * enforces is a cap that lasts until somebody edits a JS bundle. The phone
 * still enforces it too, so the user is told before they publish rather than
 * after; this is the half that has to be true.
 *
 * These are caps on what is PUBLISHED, never on what somebody keeps. A free
 * user's own library is untouched — they may have two hundred lists and every
 * one of them stays on their phone, working exactly as before. Plus buys reach,
 * not ownership, which is the only shape of paywall this app can honestly have
 * given that the phone is the source of truth.
 */
export const FREE_MAX_LISTS = 10;
export const FREE_MAX_FAVOURITES = 20;

/**
 * GRANDFATHERING, and it is the whole reason these are functions rather than
 * constants.
 *
 * People published before Plus existed. A cap that binds retroactively would
 * mean the first sync after this ships silently deletes work somebody did last
 * year — and because the intake REPLACES the whole set, it would do it without
 * anybody pressing anything. So the effective cap is never lower than what is
 * already there: 12 lists published in 2026 stay 12 for ever, and the cap only
 * ever refuses the 13th.
 *
 * The count is read fresh on each publish rather than stamped on the profile,
 * because a stamp is a second source of truth for a number the table already
 * holds, and it would have to be maintained by every path that deletes a row.
 */
async function effectiveCap(db: D1Database, sql: string, binds: unknown[], freeCap: number): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return Math.max(freeCap, row?.n ?? 0);
}

/** One read, one answer: does this profile pay? See `plusOn` for the two sources. */
async function isPlusProfile(db: D1Database, profileId: string, nowIso: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT is_plus, plus_until FROM profiles WHERE id = ?')
    .bind(profileId)
    .first<{ is_plus: number; plus_until: string | null }>();
  return row ? plusOn(row, nowIso) : false;
}

/**
 * ONE PHONE PUBLISHES A FREE PROFILE (0052).
 *
 * Every intake in this file REPLACES, and a free account on two phones holds
 * two different libraries — sync is Plus. So once both phones had published,
 * the public profile flipped to whichever spoke last, on every launch. The
 * profile is now published from ONE phone: the first to say which it is, or
 * the last one the person chose — `claim`, which the app sends once after
 * "Make this phone main" or a restore. The other phone is told so, with its
 * own code, and keeps tracking, commenting and following exactly as before.
 * NOTHING IS BLOCKED HERE: a replacement phone and a second phone look the
 * same from this side, so the choice is made on the phone, gently, not by a
 * server that cannot tell them apart.
 *
 * PLUS LIFTS IT. Sync keeps both libraries equal, so either phone's shelf is
 * the same shelf — and `hasPlus` says yes on a self-hosted instance too, for
 * the reason it does for sync. NO DEVICE, NO CHECK: a build from before this
 * sends none and must keep publishing exactly as it always did.
 *
 * The holder is still RECORDED under Plus (see the upsert below), so when a
 * subscription lapses the last phone that published is the one that keeps
 * publishing, rather than whichever happened to hold it a year ago.
 *
 * The device id is the phone's own random name for itself — the one the sync
 * relay keys its ops on — and says nothing about the hardware or the person.
 */
async function notPublisher(c: Context<App>, me: string, device: string, claim: boolean): Promise<boolean> {
  if (!device || claim) return false;
  if (await hasPlus(c)) return false;
  const row = await c.env.DB.prepare('SELECT publisher_device FROM profile_stats WHERE profile_id = ?')
    .bind(me)
    .first<{ publisher_device: string | null }>();
  return row?.publisher_device != null && row.publisher_device !== device;
}

/** The phone's name for itself, as `POST /v1/sync` takes it; '' when the
 *  build predates sending one. */
function deviceOf(b: Record<string, unknown>): string {
  return typeof b.device === 'string' ? b.device.slice(0, 64) : '';
}

/** One request carries at most this many titles. Chosen so 250 stay inside the
 *  100-parameter ceiling at 9 binds each — see `TITLE_BINDS`. It is a TRANSPORT
 *  limit, which is not the same thing as how long a shelf may be: see
 *  `PLUS_MAX_TITLES`. */
export const PUBLISH_MAX_TITLES = 250;

/**
 * HOW LONG A SHELF MAY BE, which until now was 250 by accident.
 *
 * 250 was the largest number that fitted in one request, and one request was
 * the whole protocol, so it silently became the cap on a profile. Nobody
 * decided that. A member with 900 shows published their 250 most recently
 * watched and the rest existed nowhere on this server — which is also why the
 * dashboard could not name a show somebody had rated but not shelved.
 *
 * So the shelf is now sent in chunks: the first request replaces, the rest
 * append. Free accounts still stop at one chunk, which keeps the free shelf
 * exactly the length it has always been. Plus continues.
 *
 * NOT UNBOUNDED, THOUGH. "Unlimited" in the product sense is a number large
 * enough that no real library reaches it; unbounded in the storage sense is an
 * invitation to park a megabyte per account. The largest library seen here is
 * some hundreds of shows, so this is roughly twenty times that.
 */
export const PLUS_MAX_TITLES = 5000;

/**
 * Columns bound per title row, and how many rows fit in one statement.
 *
 * DERIVED, NOT GUESSED. D1 binds at most 100 parameters per query, and a guess
 * is exactly how the aggregate list form shipped a 500 that only appeared above
 * twenty-five targets. Every column is bound — including `profile_id` and
 * `kind`, which are constant for the whole request and were briefly inlined
 * into the SQL text to save two binds. That saved nothing worth having and put
 * two values into a statement string, which is where injections come from.
 */
const TITLE_BINDS = 9;
const TITLES_PER_STATEMENT = Math.floor(D1_MAX_BOUND_PARAMS / TITLE_BINDS);

type TitleInput = {
  target_source: string;
  target_key: string;
  name?: unknown;
  poster?: unknown;
  favourite?: unknown;
  rank?: unknown;
  fav_rank?: unknown;
};

// ── PUT /v1/me/published — replace my summary ───────────────────────────────

published.put('/me/published', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const kind = b.kind;
  if (kind !== 'show' && kind !== 'movie') {
    return fail(c, 400, 'invalid_body', 'kind must be "show" or "movie".');
  }
  if (!Array.isArray(b.titles)) return fail(c, 400, 'invalid_body', 'titles must be an array.');
  if (b.titles.length > PUBLISH_MAX_TITLES) {
    return fail(c, 413, 'too_large', `At most ${PUBLISH_MAX_TITLES} titles per request.`);
  }

  const me = c.get('profileId');
  const db = c.env.DB;
  const nowIso = new Date().toISOString();

  // BEFORE anything is written, and before the append branch, so every chunk
  // of a publish answers the same way — see `notPublisher`.
  const device = deviceOf(b);
  if (await notPublisher(c, me, device, b.claim === true)) {
    return fail(c, 409, 'not_publisher', 'Another of your phones publishes this profile.');
  }

  /*
   * APPEND, FOR THE SECOND CHUNK ONWARDS.
   *
   * Without it this route is the reason a shelf stopped at 250: it replaces,
   * so a second request would delete the first. `append` keeps what is there
   * and adds to it, and the client sends it on every chunk after the first.
   *
   * PLUS ONLY, because it is the thing being paid for -- and because without
   * that check a free account could append its way past the cap simply by
   * sending twice, which would make the limit decorative.
   *
   * The stats are skipped on an appended chunk: they are the same numbers in
   * every chunk of one publish, and writing them once is enough.
   */
  const append = b.append === true;
  if (append) {
    if (!(await isPlusProfile(db, me, nowIso))) {
      return fail(c, 403, 'plus_required', 'A longer shelf is part of Plus.');
    }
    // Counted rather than trusted: the client decides how many chunks to send,
    // and a ceiling a client enforces is not a ceiling.
    const held = await db
      .prepare('SELECT COUNT(*) AS n FROM profile_titles WHERE profile_id = ? AND kind = ?')
      .bind(me, kind)
      .first<{ n: number }>();
    if ((held?.n ?? 0) + b.titles.length > PLUS_MAX_TITLES) {
      return fail(c, 413, 'too_large', `A shelf holds at most ${PLUS_MAX_TITLES} titles.`);
    }
  }

  const rows: {
    source: string;
    key: string;
    name: string | null;
    poster: string | null;
    favourite: number;
    rank: number | null;
    favRank: number | null;
  }[] = [];
  for (const raw of b.titles as TitleInput[]) {
    if (!raw || typeof raw !== 'object') continue;
    if (!isTargetSource(raw.target_source)) continue;
    if (typeof raw.target_key !== 'string' || raw.target_key.length === 0) continue;
    const rank = numberOrNull(raw.rank);
    const favRank = numberOrNull(raw.fav_rank);
    rows.push({
      source: raw.target_source,
      key: raw.target_key,
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name.slice(0, 200) : null,
      poster: typeof raw.poster === 'string' && raw.poster.length > 0 ? raw.poster.slice(0, 500) : null,
      favourite: raw.favourite === true || raw.favourite === 1 ? 1 : 0,
      rank: rank === undefined ? null : rank,
      favRank: favRank === undefined ? null : favRank,
    });
  }

  /**
   * THE FAVOURITES CAP — the shelf keeps every title, the star comes off the
   * ones past the allowance.
   *
   * Dropping the rows outright was the other option and is worse: the shelf
   * would lose titles the person watched, over a paid feature about
   * highlighting. Clearing the flag costs them the highlight and nothing else,
   * and re-subscribing restores it on the next sync with no data to recover.
   *
   * PER KIND, deliberately: one publish carries one kind, and counting the
   * other kind's favourites would make publishing films quietly shrink the
   * shows shelf — a cap that bites where the user was not looking. Twenty shows
   * and twenty films is a shelf, not an archive, which is the line these
   * numbers are drawn on.
   *
   * THE CLIENT'S OWN ORDER decides which twenty survive: the array as sent,
   * which is the owner's drag order. The server has no opinion about which of
   * somebody's favourites matters more.
   */
  const plus = await isPlusProfile(db, me, nowIso);
  let capped = false;
  let favouritesKept = rows.filter((r) => r.favourite === 1).length;
  if (!plus) {
    const allowance = await effectiveCap(
      db,
      'SELECT COUNT(*) AS n FROM profile_titles WHERE profile_id = ? AND kind = ? AND favourite = 1',
      [me, kind],
      FREE_MAX_FAVOURITES,
    );
    let kept = 0;
    for (const r of rows) {
      if (r.favourite !== 1) continue;
      if (kept < allowance) kept += 1;
      else {
        r.favourite = 0;
        capped = true;
      }
    }
    favouritesKept = kept;
  }

  /*
   * REPLACE, NOT MERGE, and `append` does not change that.
   *
   * A shelf is the whole truth about one kind at one moment: a title
   * unfollowed on the phone has to disappear here, and a merge could only ever
   * grow. What `append` splits is the TRANSPORT, not the meaning -- the first
   * chunk of a publish still clears everything, and the chunks that follow are
   * the rest of the same truth arriving in a second envelope.
   *
   * The delete and the inserts go in one batch so a crash cannot leave the
   * shelf empty. A crash BETWEEN chunks leaves it short, which is the same
   * failure a crash has always had, one chunk smaller.
   */
  const statements = [
    // The first chunk clears the shelf; the rest add to what it left.
    ...(append
      ? []
      : [db.prepare('DELETE FROM profile_titles WHERE profile_id = ? AND kind = ?').bind(me, kind)]),
    ...chunk(rows, TITLES_PER_STATEMENT).map((group) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO profile_titles
             (profile_id, kind, target_source, target_key, name, poster, favourite, rank, fav_rank)
           VALUES ${group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        )
        .bind(
          ...group.flatMap((r) => [me, kind, r.source, r.key, r.name, r.poster, r.favourite, r.rank, r.favRank]),
        ),
    ),
  ];
  // D1 throws "No SQL statements detected" on an empty batch -- an appended
  // chunk with no rows, or an empty shelf below (a 500, 21 Oct).
  if (statements.length > 0) await db.batch(statements);

  // FIRST SEEN: a title new to this shelf is stamped now; one already known
  // keeps its date (OR IGNORE). What the dashboard's Today column reads to say
  // "added Severance" — names the owner already made public, nothing more.
  const seenAt = new Date().toISOString();
  if (rows.length > 0) await db.batch(
    // 25 rows × 4 values = 100, D1's ceiling for bound parameters.
    chunk(rows, 25).map((group) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO shelf_seen (profile_id, kind, target_key, first_seen_at)
           VALUES ${group.map(() => '(?, ?, ?, ?)').join(', ')}`,
        )
        .bind(...group.flatMap((r) => [me, kind, r.key, seenAt])),
    ),
  );

  // The totals ride along with the shelf they belong to, so a profile is never
  // showing counts from one sync and titles from another.
  const stats = (b.stats ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  // PUBLISHING IS A MEMBER'S ACT: only a phone that joined publishes, so this
  // marks the server's copy of "joined" for every app version (0049).
  await db.prepare('UPDATE profiles SET joined_at = ? WHERE id = ? AND joined_at IS NULL').bind(nowIso, me).run();
  await db
    .prepare(
      `INSERT INTO profile_stats
         (profile_id, episodes_watched, minutes_watched, movie_minutes, shows_count, movies_count, updated_at,
          publisher_device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (profile_id) DO UPDATE SET
         episodes_watched = excluded.episodes_watched,
         minutes_watched  = excluded.minutes_watched,
         movie_minutes    = excluded.movie_minutes,
         shows_count      = CASE WHEN ? = 'show'  THEN excluded.shows_count  ELSE profile_stats.shows_count  END,
         movies_count     = CASE WHEN ? = 'movie' THEN excluded.movies_count ELSE profile_stats.movies_count END,
         -- The first sync of a (UTC) day stamps where the day started; later
         -- ones keep it. Read from the OLD row, which is what profile_stats.*
         -- means inside DO UPDATE.
         day_base_episodes = CASE WHEN substr(profile_stats.updated_at, 1, 10) = substr(excluded.updated_at, 1, 10)
                                  THEN profile_stats.day_base_episodes ELSE profile_stats.episodes_watched END,
         day_base_movies   = CASE WHEN substr(profile_stats.updated_at, 1, 10) = substr(excluded.updated_at, 1, 10)
                                  THEN profile_stats.day_base_movies ELSE profile_stats.movies_count END,
         updated_at       = excluded.updated_at,
         -- The phone that just spoke, when it said which (0052). An older
         -- build says nothing and the holder stays whoever it was.
         publisher_device = COALESCE(excluded.publisher_device, profile_stats.publisher_device)`,
    )
    .bind(
      me,
      n(stats.episodes_watched),
      n(stats.minutes_watched),
      n(stats.movie_minutes),
      /*
       * THE LIBRARY'S SIZE, NOT THE SHELF'S.
       *
       * This was `rows.length` — the number of titles in THIS request — and
       * the shelf is capped, so a library of two thousand films reported the
       * cap as its total. Chunking made it worse: split across requests, the
       * count became whatever the last chunk happened to hold.
       *
       * The phone sends the real figure now. `rows.length` stays as the
       * fallback for a build that does not yet, which reports the old wrong
       * number rather than a zero — wrong and unchanged beats wrong and worse.
       */
      kind === 'show' ? n(stats.shows_count) || rows.length : 0,
      kind === 'movie' ? n(stats.movies_count) || rows.length : 0,
      nowIso,
      device || null,
      kind,
      kind,
    )
    .run();

  /**
   * A SUCCESS WITH A NOTE, not a 409.
   *
   * Every failure this intake has is a malformed body the phone should never
   * send again; a publish that was too generous is neither malformed nor worth
   * retrying, and the correct outcome is that the shelf goes up. So the cap
   * rides in the success envelope — `capped` for "we trimmed something",
   * `kept` for how many favourites survived, which is what an upsell line has
   * to say. The fields are absent when nothing was trimmed, so a client that
   * never reads them sees the old response exactly.
   */
  return c.json({ ok: true, kind, titles: rows.length, ...(capped ? { capped: true, kept: favouritesKept } : {}) });
});

// ── GET /v1/profiles/:handle/published ──────────────────────────────────────

type ShelfRow = {
  kind: string;
  target_source: string;
  target_key: string;
  name: string | null;
  poster: string | null;
  favourite: number;
  rank: number | null;
  fav_rank: number | null;
};

published.get('/profiles/:handle/published', async (c) => {
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));
  const db = c.env.DB;

  // The same visibility rules the rest of a profile follows, in one statement:
  // a deleted account, or a block in either direction, is a 404 — never a 403,
  // which would confirm the account exists.
  const owner = await db
    .prepare(
      `SELECT p.id, p.is_private, p.hidden_sections,
              -- ACCEPTED ONLY. This boolean is the gate on a private profile's
              -- entire published history; a pending request must open nothing,
              -- or asking to follow would BE following.
              EXISTS(SELECT 1 FROM follows f
                      WHERE f.follower_id = ? AND f.followee_id = p.id AND f.state = 'accepted') AS followed_by_me,
              EXISTS(SELECT 1 FROM blocks b
                     WHERE (b.blocker_id = ? AND b.blocked_id = p.id)
                        OR (b.blocker_id = p.id AND b.blocked_id = ?)) AS blocked
         FROM profiles p
        WHERE p.handle_lower = ? AND p.deleted_at IS NULL
          AND (p.joined_at IS NOT NULL OR p.id = ?)`,
    )
    .bind(viewer, viewer, viewer, (c.req.param('handle') ?? '').toLowerCase(), viewer)
    .first<{
      id: string;
      is_private: number;
      hidden_sections: string | null;
      followed_by_me: number;
      blocked: number;
    }>();

  if (!owner || owner.blocked === 1) return fail(c, 404, 'not_found', 'No such profile.');
  const maySee = owner.is_private === 0 || owner.id === viewer || owner.followed_by_me === 1;
  if (!maySee) return fail(c, 403, 'forbidden', 'This profile is private.');

  const stats = await db
    .prepare(
      `SELECT episodes_watched, minutes_watched, movie_minutes, shows_count, movies_count, updated_at
         FROM profile_stats WHERE profile_id = ?`,
    )
    .bind(owner.id)
    .first<{
      episodes_watched: number;
      minutes_watched: number;
      movie_minutes: number;
      shows_count: number;
      movies_count: number;
      updated_at: string;
    }>();

  // THE OWNER'S ORDER, and nothing else's. `favourite DESC` used to come
  // first, which reordered every shelf around a flag the shelf is not sorted
  // by — so a public profile listed the same titles as the owner's own screen
  // in a different order. Unranked rows fall to the end by name, so a shelf
  // published before ranks existed is still stable rather than whatever SQLite
  // felt like returning.
  const res = await db
    .prepare(
      `SELECT kind, target_source, target_key, name, poster, favourite, rank, fav_rank
         FROM profile_titles
        WHERE profile_id = ?
        ORDER BY kind, rank IS NULL, rank, name`,
    )
    .bind(owner.id)
    .all<ShelfRow>();

  /**
   * PER-SECTION HIDING, enforced on the data rather than on the client.
   *
   * Every shelf this route draws is one of the owner's switches, so each one is
   * dropped here for anybody but them. A hidden favourites rail is subtler than
   * a hidden shelf: the titles stay — they are the ordinary watched shelf —
   * and only the STAR comes off, because it is the "these are my favourites"
   * claim that was hidden, not the fact that the person watched them.
   */
  const owns = owner.id === viewer;
  const hides = (key: 'stats' | 'shows' | 'movies' | 'favourite_shows' | 'favourite_movies') =>
    !owns && sectionHidden(owner.hidden_sections, key);

  const shape = (r: ShelfRow) => {
    const favouritesShown = !hides(r.kind === 'show' ? 'favourite_shows' : 'favourite_movies');
    return {
      target_source: r.target_source,
      target_key: r.target_key,
      name: r.name,
      poster: r.poster,
      favourite: favouritesShown && r.favourite === 1,
      // Sent so the client can order the FAVOURITES shelf on its own terms —
      // the owner's drag order, which is not the main shelf's order.
      fav_rank: favouritesShown ? r.fav_rank : null,
    };
  };
  const all = res.results ?? [];
  const shelf = (kind: 'show' | 'movie') =>
    hides(kind === 'show' ? 'shows' : 'movies') ? [] : all.filter((r) => r.kind === kind).map(shape);

  return c.json({
    // Null rather than zeroes when nothing has been published: a profile that
    // has never synced must render as "no stats yet", not as somebody who has
    // watched nothing. A HIDDEN stats section reads as the same null, which is
    // the shape the client already knows how to draw nothing from.
    stats: stats && !hides('stats')
      ? {
          episodes_watched: stats.episodes_watched,
          minutes_watched: stats.minutes_watched,
          movie_minutes: stats.movie_minutes,
          shows_count: stats.shows_count,
          movies_count: stats.movies_count,
          updated_at: stats.updated_at,
        }
      : null,
    shows: shelf('show'),
    movies: shelf('movie'),
  });
});

// ── POST /v1/published/lists ────────────────────────────────────────────────

/** A profile is a shelf, not an archive: enough to browse, not a full library. */
export const PUBLISH_MAX_LISTS = 50;
export const PUBLISH_MAX_LIST_ITEMS = 200;

type ListInput = {
  name?: unknown;
  description?: unknown;
  items?: unknown;
};

type ListItemInput = {
  target_source?: unknown;
  target_key?: unknown;
  title?: unknown;
  poster?: unknown;
};

/**
 * Publish the owner's lists — the band a public profile has never been able to
 * draw.
 *
 * THE TABLES HAVE ALWAYS BEEN HERE, and so has the reading: `/profiles/:handle/
 * lists`, `/lists/:id`, the client functions and the screen. Nothing ever wrote
 * them, so every profile showed no lists and the section simply did not appear.
 *
 * REPLACE, not merge — the same rule the title shelves follow. The phone sends
 * the lists it wants public and this becomes the whole truth; a list deleted or
 * hidden on the phone has to vanish here, and a merge could only ever grow.
 *
 * PRIVACY IS THE PHONE'S DECISION. Anything marked "Hide from profile" is never
 * sent, so there is nothing here to leak. `is_public` is written 1 for what
 * arrives, because arriving IS the act of publishing it.
 */
published.post('/published/lists', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.lists)) return fail(c, 400, 'invalid_body', 'lists must be an array.');
  if (b.lists.length > PUBLISH_MAX_LISTS) {
    return fail(c, 413, 'too_large', `At most ${PUBLISH_MAX_LISTS} lists per request.`);
  }

  const me = c.get('profileId');
  const db = c.env.DB;
  const nowIso = new Date().toISOString();

  // The same gate as the shelves, and no `claim` here: the app sends the lists
  // after the shelves on one run, so the PUT above has already settled who
  // publishes — this only has to agree with it.
  if (await notPublisher(c, me, deviceOf(b), false)) {
    return fail(c, 409, 'not_publisher', 'Another of your phones publishes this profile.');
  }

  const lists: { id: string; name: string; description: string | null; items: {
    source: string; key: string; title: string | null; poster: string | null;
  }[] }[] = [];

  for (const raw of b.lists as ListInput[]) {
    if (!raw || typeof raw !== 'object') continue;
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : '';
    if (name.length === 0) continue;

    const items: { source: string; key: string; title: string | null; poster: string | null }[] = [];
    if (Array.isArray(raw.items)) {
      for (const it of (raw.items as ListItemInput[]).slice(0, PUBLISH_MAX_LIST_ITEMS)) {
        if (!it || typeof it !== 'object') continue;
        if (!isTargetSource(it.target_source)) continue;
        if (typeof it.target_key !== 'string' || it.target_key.length === 0) continue;
        items.push({
          source: it.target_source,
          key: it.target_key,
          title: typeof it.title === 'string' && it.title.length > 0 ? it.title.slice(0, 200) : null,
          poster: typeof it.poster === 'string' && it.poster.length > 0 ? it.poster.slice(0, 500) : null,
        });
      }
    }

    // DERIVED from the owner and the name, not random: re-publishing must land
    // on the same id, or every sync would hand a reader a new URL for a list
    // they already had open.
    //
    // ONE LIST PER ID. `listId` folds case, so "Favourites" and "favourites"
    // — two lists on the phone — share an id, and the second INSERT broke the
    // primary key: a 500 that cost the member every list (omar, Oct 2026).
    // The first one in the owner's order wins.
    const id = listId(me, name);
    if (lists.some((l) => l.id === id)) continue;
    lists.push({ id, name, description: null, items });
  }

  /**
   * THE LISTS CAP. The first ten in the order the phone sent — the owner's own
   * arrangement, which is also the order the profile draws them in, so what
   * survives is the top of their own screen rather than an arbitrary ten.
   *
   * Grandfathered: see `effectiveCap`. The count is taken BEFORE the delete
   * below, which is the only moment it can be taken — this intake replaces the
   * whole set, so a cap read afterwards would always see zero and never bind.
   */
  const kept = (await isPlusProfile(db, me, nowIso))
    ? lists.length
    : Math.min(
        lists.length,
        await effectiveCap(db, 'SELECT COUNT(*) AS n FROM lists WHERE owner_id = ?', [me], FREE_MAX_LISTS),
      );
  const capped = kept < lists.length;
  lists.length = kept;

  const statements = [
    db.prepare('DELETE FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE owner_id = ?)').bind(me),
    db.prepare('DELETE FROM lists WHERE owner_id = ?').bind(me),
  ];
  lists.forEach((l, position) => {
    // POSITION IS THE ARRAY ORDER the phone sent. The owner arranged them; this
    // is the only place that arrangement can reach anybody else.
    statements.push(
      db
        .prepare(
          `INSERT INTO lists (id, owner_id, name, description, is_public, created_at, position)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(l.id, me, l.name, l.description, nowIso, position),
    );
    l.items.forEach((it, i) => {
      statements.push(
        db
          .prepare(
            `INSERT INTO list_items (list_id, position, target_source, target_key, title, poster)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(l.id, i, it.source, it.key, it.title, it.poster),
      );
    });
  });

  await db.batch(statements);
  // Same idiom as the shelf above: a success, plus what was trimmed.
  return c.json({ lists: lists.length, ...(capped ? { capped: true, kept } : {}) });
});
