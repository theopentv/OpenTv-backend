import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import {
  IMPORT_MAX_ITEMS,
  isTargetSource,
  isValidBcp47,
  numberOrNull,
  importedCommentBodyOk,
  stableImportId,
  stableRatingId,
  tvtimeCommentId,
  validateCommentBody,
  validateVote,
  VOTE_IMPORT_MAX_ITEMS,
} from '@/pure';

/**
 * Opt-in seeding — the user's own TV Time archive, brought with them.
 * docs/IMPLEMENTATION.md Step 3, "Opt-in seeding".
 *
 * Fired by the app after the join prompt, which itself fires after a successful
 * import: *"you imported 47 comments — bring them with you?"*
 *
 * Two properties make these endpoints safe to call repeatedly, which they will
 * be:
 *
 *  1. The id is DERIVED (`stableImportId`, `stableRatingId`), so a re-import is
 *     a no-op with no read-before-write. This mirrors the app's own merge-safe
 *     import rule.
 *  2. `created_at` comes from the ITEM — these are comments from 2019 and must
 *     sort as such — while `imported_at` is now, which is how the UI knows to
 *     mark them as brought-from-TV-Time rather than freshly written.
 *
 * Imported anything never generates notifications. Nobody wants an inbox full
 * of replies they wrote themselves seven years ago.
 */

export const seeding = new Hono<App>();

/** D1 takes large batches, but 50 statements a round trip keeps each one well inside every limit. */
const BATCH_CHUNK = 50;

type Prepared = {
  id: string;
  source: string;
  key: string;
  season: number | null;
  episode: number | null;
  body: string;
  isSpoiler: number;
  lang: string | null;
  createdAt: string;
  /** TV Time's own id for this comment, and for the one it answered — see 0062. */
  tvtimeId: string | null;
  tvtimeParentId: string | null;
};

/**
 * The comment a TV Time parent id names, ON THE SAME THREAD, as the root a reply
 * may hang off: replies are one level deep, so a reply to a reply hangs off the
 * reply's own parent. Binds the parent's tvtime id unless given an expression. The `r` alias is the row
 * being given a parent. A deleted parent is still a parent — the reply follows
 * it out of the thread exactly as a live reply does, and back if it returns.
 */
const PARENT_OF = (r: string, tvtimeId = '?') => `(SELECT COALESCE(p.parent_id, p.id) FROM comments p
   WHERE p.tvtime_id = ${tvtimeId} AND p.target_source = ${r}.target_source AND p.target_key = ${r}.target_key
     AND p.season IS ${r}.season AND p.episode IS ${r}.episode AND p.id <> ${r}.id
   ORDER BY p.deleted_at IS NOT NULL LIMIT 1)`;

seeding.post('/comments/import', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return fail(c, 400, 'invalid_body', 'items must be an array.');
  if (items.length === 0) return c.json({ imported: 0, skipped: 0 });
  if (items.length > IMPORT_MAX_ITEMS) {
    // 400 with `too_large`, not 413: the error table in the conventions section
    // lists `too_large` as a code and does not list 413 as a status. The app
    // chunks at 200; a client that does not is asking a question the code
    // string answers precisely.
    return fail(c, 400, 'too_large', `At most ${IMPORT_MAX_ITEMS} items per call.`);
  }

  const db = c.env.DB;
  const me = c.get('profileId');
  const nowIso = new Date().toISOString();

  const alive = await db
    .prepare('SELECT 1 AS one FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first();
  if (!alive) return fail(c, 401, 'unauthenticated', 'No such profile.');

  // An item that fails validation is SKIPPED, not fatal. A single malformed row
  // in a seven-year-old export must not be able to block the whole seeding
  // forever, and `skipped` is exactly where the user's count of "not brought
  // over" belongs. `skipped` therefore covers both duplicates and rejects.
  const prepared: Prepared[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const it = raw as Record<string, unknown>;

    if (!isTargetSource(it.target_source)) continue;
    if (typeof it.target_key !== 'string' || it.target_key.length === 0) continue;

    // An empty body is allowed only when the client says a photograph follows
    // — TV Time let people post a picture with no caption, and refusing those
    // rows here is what stranded their images. See `importedCommentBodyOk`.
    const text = importedCommentBodyOk(it.body, it.has_image === true || it.has_image === 1);
    if (!text.ok) continue;

    const season = numberOrNull(it.season);
    if (season === undefined) continue;
    const episode = numberOrNull(it.episode);
    if (episode === undefined) continue;

    // The historical timestamp is the whole point; a missing or unparseable one
    // cannot be silently replaced with now, because that would put a 2019
    // comment at the top of today's thread.
    if (typeof it.created_at !== 'string' || Number.isNaN(Date.parse(it.created_at))) continue;
    const createdAt = it.created_at;

    prepared.push({
      id: await stableImportId({
        authorId: me,
        targetSource: it.target_source,
        targetKey: it.target_key,
        season,
        episode,
        createdAt,
        body: text.body,
      }),
      source: it.target_source,
      key: it.target_key,
      season,
      episode,
      body: text.body,
      isSpoiler: it.is_spoiler === true || it.is_spoiler === 1 ? 1 : 0,
      lang: isValidBcp47(it.lang) ? it.lang : null,
      createdAt,
      tvtimeId: tvtimeCommentId(it.tvtime_id),
      tvtimeParentId: tvtimeCommentId(it.tvtime_parent_id),
    });
  }

  let imported = 0;
  for (let i = 0; i < prepared.length; i += BATCH_CHUNK) {
    const chunk = prepared.slice(i, i + BATCH_CHUNK);
    const statements: D1PreparedStatement[] = [];
    const insertAt: number[] = [];
    for (const p of chunk) {
      insertAt.push(statements.length);
      statements.push(
        db
          .prepare(
            /*
             * NOT A SECOND COPY OF SOMETHING WRITTEN IN THE APP (12 Oct). The
             * derived id dedupes an import against itself, never against a
             * comment written live, which has a random `c_` id — so a second
             * device seeding the same history put every app-written comment
             * up twice, photo and all, back in the review queue. Same author,
             * target, episode and words within two minutes is the same
             * comment; the author index keeps the check cheap.
             */
            `INSERT OR IGNORE INTO comments
               (id, author_id, target_source, target_key, season, episode, body, is_spoiler, lang,
                parent_id, imported_at, created_at, tvtime_id, tvtime_parent_id)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    (SELECT COALESCE(p.parent_id, p.id) FROM comments p
                      WHERE p.tvtime_id = ? AND p.target_source = ? AND p.target_key = ?
                        AND p.season IS ? AND p.episode IS ?
                      ORDER BY p.deleted_at IS NOT NULL LIMIT 1),
                    ?, ?, ?, ?
              WHERE NOT EXISTS (
                SELECT 1 FROM comments o
                 WHERE o.author_id = ? AND o.target_source = ? AND o.target_key = ?
                   AND o.season IS ? AND o.episode IS ? AND o.body = ?
                   AND o.id NOT LIKE 'imp!_%' ESCAPE '!'
                   AND abs(julianday(o.created_at) - julianday(?)) * 86400 < 120)`,
          )
          .bind(
            p.id,
            me,
            p.source,
            p.key,
            p.season,
            p.episode,
            p.body,
            p.isSpoiler,
            p.lang,
            p.tvtimeParentId,
            p.source,
            p.key,
            p.season,
            p.episode,
            nowIso,
            p.createdAt,
            p.tvtimeId,
            p.tvtimeParentId,
            me,
            p.source,
            p.key,
            p.season,
            p.episode,
            p.body,
            p.createdAt,
          ),
      );
      /*
       * THE BACKFILL. A row seeded before 0062 has the same derived id and so
       * was skipped by the insert above; this gives it the TV Time ids once
       * (`tvtime_id IS NULL`), and a parent if that is already here. Not
       * counted as imported — the comment was already on the server.
       */
      if (p.tvtimeId || p.tvtimeParentId) {
        statements.push(
          db
            .prepare(
              `UPDATE comments AS r SET tvtime_id = ?, tvtime_parent_id = ?,
                      parent_id = COALESCE(r.parent_id, ${PARENT_OF('r')})
                WHERE r.id = ? AND r.author_id = ? AND r.tvtime_id IS NULL`,
            )
            .bind(p.tvtimeId, p.tvtimeParentId, p.tvtimeParentId, p.id, me),
        );
      }
    }

    const ids = JSON.stringify(chunk.map((p) => p.tvtimeId).filter((v): v is string => v !== null));
    if (ids !== '[]') {
      // ADOPT: replies already here — usually somebody else's — that were
      // waiting for one of the comments this chunk just brought.
      statements.push(
        db
          .prepare(
            `UPDATE comments AS r SET parent_id = ${PARENT_OF('r', 'r.tvtime_parent_id')}
              WHERE r.parent_id IS NULL AND r.tvtime_parent_id IN (SELECT value FROM json_each(?))`,
          )
          .bind(ids),
      );
      // ONE LEVEL DEEP, still. A comment that had replies of its own while it
      // was an orphan, and has just become a reply itself, hands them to its
      // new parent — otherwise they would point at a reply, which no read shows.
      statements.push(
        db
          .prepare(
            `UPDATE comments AS c SET parent_id = (SELECT x.parent_id FROM comments x WHERE x.id = c.parent_id)
              WHERE c.parent_id IN (SELECT r.id FROM comments r
                                     WHERE r.parent_id IS NOT NULL
                                       AND (r.tvtime_id IN (SELECT value FROM json_each(?))
                                            OR r.tvtime_parent_id IN (SELECT value FROM json_each(?))))`,
          )
          .bind(ids, ids),
      );
    }

    const results = await db.batch(statements);
    for (const n of insertAt) imported += results[n]?.meta?.changes ?? 0;
  }

  return c.json({ imported, skipped: items.length - imported });
});

// ── POST /v1/ratings/import ─────────────────────────────────────────────────
//
// The endpoint this whole file existed only half of. A user could seed their
// comments and nothing else, so every rating and every emotion an archive
// carried stayed on the phone and every community percentage started at zero
// and stayed there. Seeding the votes without moving the rollups would have
// been the same bug wearing a success message: `ratings` full, `%` empty.
//
// DEDUPE BY CONSTRUCTION, twice over:
//
//  1. The id is derived from (author, target) alone — `stableRatingId` — so the
//     same export imported twice inserts the same primary key.
//  2. The row may ALSO already exist under a random `r_…` id from a live vote,
//     which the derived id cannot know about. `ON CONFLICT … DO NOTHING` names
//     `idx_one_vote_per_person` BY ITS EXPRESSION, COALESCE included: SQLite
//     matches expression indexes by expression, not by name, and a mistyped
//     target turns the upsert into a constraint error.
//
// An import never overwrites a live vote. Someone who rated an episode 9 in the
// app this morning and then seeds a 6 from a 2019 archive keeps the 9 — the
// newer, deliberate act wins over the older, bulk one.
//
// FEELINGS ARE A SET here too (migrations/0005_emotion_votes.sql), and an
// archive is where the multi-selections actually are: TV Time let people tap
// several on one episode and every one of them is in the export. An item's
// `emotions` array seeds one `emotion_votes` row each, guarded individually —
// see the batch below. Unlike the live route, an import never REPLACES a set:
// bulk history may only add feelings a person does not already hold, for the
// same reason it may not overwrite a score.

type PreparedVote = {
  id: string;
  source: string;
  key: string;
  season: number | null;
  episode: number | null;
  score: number | null;
  emotions: string[];
  createdAt: string;
};

seeding.post('/ratings/import', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return fail(c, 400, 'invalid_body', 'items must be an array.');
  if (items.length === 0) return c.json({ imported: 0, skipped: 0 });
  if (items.length > VOTE_IMPORT_MAX_ITEMS) {
    return fail(c, 400, 'too_large', `At most ${VOTE_IMPORT_MAX_ITEMS} items per call.`);
  }

  const db = c.env.DB;
  const me = c.get('profileId');
  const nowIso = new Date().toISOString();

  const alive = await db
    .prepare('SELECT 1 AS one FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first();
  if (!alive) return fail(c, 401, 'unauthenticated', 'No such profile.');

  // Invalid items are SKIPPED and counted, never fatal: one malformed row in a
  // seven-year-old export must not be able to block the whole seeding forever.
  const prepared: PreparedVote[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const it = raw as Record<string, unknown>;

    if (!isTargetSource(it.target_source)) continue;
    if (typeof it.target_key !== 'string' || it.target_key.length === 0) continue;

    // The same gate the live vote passes, allow-listed emotion included — an
    // unvalidated emotion becomes a JSON path in the aggregate upsert below.
    const check = validateVote(it);
    if (!check.ok) continue;
    const v = check.vote;

    // Unlike a comment, a missing or unparseable timestamp is NOT fatal here.
    // Nothing sorts by a rating's `created_at`; it is provenance, and refusing
    // a whole vote over it would drop a percentage to protect a field nobody
    // reads.
    const createdAt =
      typeof it.created_at === 'string' && !Number.isNaN(Date.parse(it.created_at))
        ? it.created_at
        : nowIso;

    prepared.push({
      id: await stableRatingId({
        authorId: me,
        targetSource: it.target_source,
        targetKey: it.target_key,
        season: v.season,
        episode: v.episode,
      }),
      source: it.target_source,
      key: it.target_key,
      season: v.season,
      episode: v.episode,
      score: v.score,
      // `undefined` (the item mentioned no feelings) and `[]` mean the same
      // thing to an importer: there is nothing to add. The absent/empty
      // distinction only matters where a set can be REPLACED, and this endpoint
      // never replaces one.
      emotions: v.emotions ?? [],
      createdAt,
    });
  }

  let imported = 0;
  for (let i = 0; i < prepared.length; i += BATCH_CHUNK) {
    const statements: D1PreparedStatement[] = [];
    // Which statements in the batch are the vote insert whose `changes` counts
    // as "imported". An item no longer contributes a fixed number of statements
    // — it contributes two per feeling as well — so the old every-second-result
    // rule cannot survive, and the positions are recorded as they are built.
    const voteInsertAt: number[] = [];
    const chunk = prepared.slice(i, i + BATCH_CHUNK);

    for (const p of chunk) {
      // rating_aggregates' primary key cannot hold NULLs, so a show- or
      // film-level vote is -1/-1 there. `ratings` keeps the NULLs.
      const s = p.season ?? -1;
      const e = p.episode ?? -1;

      // THE ORDER OF THESE TWO STATEMENTS IS THE WHOLE MECHANISM.
      //
      // The rollup goes FIRST, guarded by `WHERE NOT EXISTS (the vote)`. A
      // `db.batch()` is one implicit transaction executed in order, so the
      // guard sees the world as it was before this item's insert — and, on a
      // re-import, sees the row that is already there and adds nothing. Two
      // copies of the same item inside one payload behave correctly for the
      // same reason: the second guard sees the first insert.
      //
      // Doing it the other way round — insert, then rollup — would need the
      // insert's `meta.changes` to decide, and a batch cannot branch on a
      // result. Doing it in two round trips would let the two diverge.
      statements.push(
        db
          .prepare(
            `INSERT INTO rating_aggregates
               (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts,
                score_counts, updated_at)
             SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?
              WHERE NOT EXISTS (
                SELECT 1 FROM ratings r
                 WHERE r.author_id = ? AND r.target_source = ? AND r.target_key = ?
                   AND COALESCE(r.season, -1) = ? AND COALESCE(r.episode, -1) = ?)
             ON CONFLICT (target_source, target_key, season, episode) DO UPDATE SET
               vote_count = rating_aggregates.vote_count + 1,
               score_sum  = rating_aggregates.score_sum + excluded.score_sum,
               ${
                 // The distribution, seeded by the same statement that seeds the
                 // sum. Without this half, importing an archive would fill
                 // `score_counts` for nobody: every star bar would read 0% while
                 // `vote_count` climbed into the thousands — `ratings` full, `%`
                 // empty, the exact bug this endpoint was written to fix, one
                 // column over. The path is quoted; `p.score` came through
                 // `validateVote` and is an integer in 1..10.
                 p.score === null
                   ? ''
                   : `score_counts = json_set(
                        COALESCE(rating_aggregates.score_counts, '{}'), '$."' || ? || '"',
                        COALESCE(json_extract(rating_aggregates.score_counts, '$."' || ? || '"'), 0) + 1),`
               }
               updated_at = excluded.updated_at`,
          )
          .bind(
            p.source,
            p.key,
            s,
            e,
            p.score ?? 0,
            // The feelings no longer ride along in this statement: one archive
            // item can carry several, and a single `json_set` pair can seed one.
            // They get a guarded statement each, below.
            '{}',
            p.score === null ? '{}' : JSON.stringify({ [p.score]: 1 }),
            nowIso,
            me,
            p.source,
            p.key,
            s,
            e,
            // As a STRING, for the reason spelled out in routes/ratings.ts: a
            // number bound into `'$."' || ? || '"'` can arrive as a float and
            // open a `$."10.0"` bucket nothing will ever read.
            ...(p.score === null ? [] : [String(p.score), String(p.score)]),
          ),
      );

      // ONE PAIR PER FEELING, on the same rollup-first principle: each rollup is
      // guarded by `WHERE NOT EXISTS (that exact emotion_votes row)`, so a
      // re-import — or the same feeling twice inside one payload — adds nothing,
      // and the `INSERT OR IGNORE` that follows it makes the guard true for
      // every later attempt.
      //
      // `vote_count` is 0 in the INSERT half: this statement seeds a SELECTION,
      // never a person. The person is counted once, by the statement above, out
      // of their `ratings` row.
      for (const emotion of p.emotions) {
        statements.push(
          db
            .prepare(
              `INSERT INTO rating_aggregates
                 (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts,
                  score_counts, updated_at)
               SELECT ?, ?, ?, ?, 0, 0, ?, '{}', ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM emotion_votes ev
                   WHERE ev.author_id = ? AND ev.target_source = ? AND ev.target_key = ?
                     AND ev.season = ? AND ev.episode = ? AND ev.emotion = ?)
               ON CONFLICT (target_source, target_key, season, episode) DO UPDATE SET
                 emotion_counts = json_set(
                   COALESCE(rating_aggregates.emotion_counts, '{}'), '$."' || ? || '"',
                   COALESCE(json_extract(rating_aggregates.emotion_counts, '$."' || ? || '"'), 0) + 1),
                 updated_at = excluded.updated_at`,
            )
            .bind(
              p.source,
              p.key,
              s,
              e,
              JSON.stringify({ [emotion]: 1 }),
              nowIso,
              me,
              p.source,
              p.key,
              s,
              e,
              emotion,
              emotion,
              emotion,
            ),
        );

        statements.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO emotion_votes
                 (author_id, target_source, target_key, season, episode, emotion, created_at, imported_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(me, p.source, p.key, s, e, emotion, p.createdAt, nowIso),
        );
      }

      voteInsertAt.push(statements.length);
      statements.push(
        db
          .prepare(
            // `emotion` is not written: the column is stranded NULL by 0005.
            // `imported_at` is what makes a bulk arrival distinguishable from
            // somebody rating an episode tonight. `created_at` stays as it was
            // — for a rating that is the upload moment, because TV Time's
            // export carries no rating date and the phone stores none.
            `INSERT INTO ratings
               (id, author_id, target_source, target_key, season, episode, score, created_at, imported_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (author_id, target_source, target_key,
                          COALESCE(season, -1), COALESCE(episode, -1)) DO NOTHING`,
          )
          .bind(p.id, me, p.source, p.key, p.season, p.episode, p.score, p.createdAt, nowIso),
      );
    }

    const results = await db.batch(statements);
    // Only the vote inserts count. A feeling seeded onto a vote that already
    // existed is not an imported item, and the rollups are not items at all.
    for (const n of voteInsertAt) imported += results[n]?.meta?.changes ?? 0;
  }

  return c.json({ imported, skipped: items.length - imported });
});
