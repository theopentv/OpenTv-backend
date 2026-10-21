import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { rememberTitleName } from '@/title-names';
import { sendPush } from '@/push';
import {
  COMMENTS_PER_HOUR,
  firstAcceptLanguage,
  isTargetSource,
  isValidBcp47,
  makeCursor,
  numberOrNull,
  pageSize,
  parseCursor,
  plusOn,
  replyDepthOk,
  shouldNotify,
  stableImportId,
  validateCommentBody,
} from '@/pure';
import { verify } from '@/session';
import { unshareComment } from '@/routes/commsuni';

/**
 * Threads, and the moderation tools that ship *with* them.
 * docs/IMPLEMENTATION.md Step 3.
 *
 * Two rules run through every statement in this file:
 *
 *  1. A thread read filters `deleted_at IS NULL AND hidden_at IS NULL` — an
 *     author's deletion and an automatic hide are different columns on purpose
 *     (migration 0002).
 *  2. Blocks filter BOTH directions. Apple 1.2 asks that I not see them; the
 *     other half is what stops a block from being a one-way mute the blocked
 *     party works around by refreshing.
 */

export const comments = new Hono<App>();

// ── shapes ───────────────────────────────────────────────────────────────────

export type CommentRow = {
  id: string;
  /** Set once the comment is shared to CommsUni. */
  commsuni_id?: string | null;
  author_id: string;
  target_source: string;
  target_key: string;
  season: number | null;
  episode: number | null;
  body: string;
  is_spoiler: number;
  lang: string | null;
  parent_id: string | null;
  imported_at: string | null;
  like_count: number;
  created_at: string;
  edited_at: string | null;
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  is_plus?: number;
  plus_until?: string | null;
  liked_by_me?: number;
  reply_count?: number;
  /**
   * The rescued TV Time photograph, joined in from `comment_images` — and only
   * when a person has looked at it. `scan_status` is checked in SQL rather than
   * here so an unreviewed image cannot reach the shaper at all.
   */
  image_w?: number | null;
  image_h?: number | null;
  image_gif?: number | null;
  image_ok?: number | null;
  image_scan?: string | null;
  orphan_reply?: number;
};

/** One shaper for POST and GET, so the row the author sees is the row the thread shows. */
export function shapeComment(row: CommentRow, viewerId = '') {
  return {
    id: row.id,
    author: {
      id: row.author_id,
      handle: row.handle,
      display_name: row.display_name,
      avatar_key: row.avatar_key,
      // The badge belongs to the name, wherever the name is drawn — see the
      // note in `routes/profiles.ts`. Optional on the row rather than
      // required: an older query that does not select it reads as not-Plus,
      // which is the safe direction to be wrong in.
      is_plus: plusOn(row, new Date().toISOString()),
    },
    target_source: row.target_source,
    target_key: row.target_key,
    season: row.season,
    episode: row.episode,
    body: row.body,
    is_spoiler: row.is_spoiler,
    lang: row.lang,
    parent_id: row.parent_id,
    // Lets the UI mark a comment as brought-from-TV-Time rather than freshly
    // written, which is the entire reason the column exists.
    imported_at: row.imported_at,
    like_count: row.like_count,
    liked_by_me: !!row.liked_by_me,
    reply_count: row.reply_count ?? 0,
    created_at: row.created_at,
    edited_at: row.edited_at,
    /**
     * THE PICTURE, once somebody has cleared it.
     *
     * Not a URL — the app builds one from the comment id, which it already has,
     * so nothing here needs to know the Worker's own hostname. `null` covers
     * three different things deliberately: no image, an image nobody has
     * reviewed, and an image that was reviewed and refused. A reader is not
     * told which, because "there is a picture here you are not allowed to see"
     * is an invitation to ask why.
     */
    image: row.image_ok
      ? { width: row.image_w ?? null, height: row.image_h ?? null, is_gif: !!row.image_gif }
      : null,
    /**
     * "YOUR PICTURE IS BEING LOOKED AT" — and only its own author is told.
     *
     * Nothing is served until a person approves it, which is right and is not
     * changing. But saying nothing to the AUTHOR means they post a photograph
     * and see a comment without one: indistinguishable from the upload having
     * failed, which is what they had just been fighting. So they get the fact
     * that it exists and is waiting, and the app draws it blurred.
     *
     * Everybody else gets `false`. A stranger is never told a picture is
     * pending, because "there is something here you cannot see yet" is the same
     * invitation as "you may not see this". `viewerId` defaults to '' so a
     * caller that forgets it reveals nothing rather than revealing everything.
     */
    image_pending: row.image_scan === 'pending' && !!viewerId && row.author_id === viewerId,
    /** Also on CommsUni — so the thread can stop calling it "OpenTV only". */
    shared: !!row.commsuni_id,
    /**
     * A TV Time REPLY whose original is not on this server (yet). It stands at
     * the top of the thread because there is nothing to hang it under, and the
     * app says what it is rather than letting it read as a stray post. It stops
     * being one the moment the original's author imports — see the adopt step
     * in routes/import.ts.
     */
    orphan_reply: !!row.orphan_reply,
  };
}

/** The columns every read of a comment selects, so the shaper always has them. */
export const COMMENT_COLUMNS = `c.id, c.author_id, c.target_source, c.target_key, c.season, c.episode,
       c.body, c.is_spoiler, c.lang, c.parent_id, c.imported_at, c.like_count,
       c.created_at, c.edited_at, c.commsuni_id,
       (c.parent_id IS NULL AND c.tvtime_parent_id IS NOT NULL) AS orphan_reply,
       p.handle, p.display_name, p.avatar_key, p.is_plus, p.plus_until,
       ci.width AS image_w, ci.height AS image_h, ci.is_gif AS image_gif,
       (ci.scan_status = 'clean') AS image_ok,
       -- The RAW status, because who may be told about a pending picture
       -- depends on who is asking, and this file assembles its binds in
       -- placeholder order: a question-mark here would silently shift every
       -- one of them. shapeComment compares it against the viewer instead.
       ci.scan_status AS image_scan`;

/**
 * The image join, on every read of a comment.
 *
 * LEFT, because most comments have no picture and an inner join would silently
 * drop every one of them. The `clean` test lives in `COMMENT_COLUMNS` rather
 * than here so a pending image still joins and simply reports itself as absent
 * — one query shape for every case.
 */
export const IMAGE_JOIN = 'LEFT JOIN comment_images ci ON ci.comment_id = c.id';

/**
 * The block filter, both directions, as a fragment. `?me` is `''` for an
 * anonymous reader, which makes both halves trivially false — no branching
 * SQL, one statement for everybody.
 */
const NOT_BLOCKED = `NOT EXISTS (SELECT 1 FROM blocks b
                  WHERE (b.blocker_id = ? AND b.blocked_id = c.author_id)
                     OR (b.blocker_id = c.author_id AND b.blocked_id = ?))`;

/** The reader's profile id, or `''`. Open route, so `requireAuth` is deliberately not mounted. */
export async function optionalViewer(env: Env, header: string | undefined): Promise<string> {
  const match = /^Bearer (.+)$/.exec((header ?? '').trim());
  if (!match) return '';
  return (await verify(env, match[1]!, Date.now())) ?? '';
}

export function newCommentId(): string {
  return `c_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function newNotificationId(): string {
  return `n_${crypto.randomUUID().replace(/-/g, '')}`;
}

// ── POST /v1/comments ────────────────────────────────────────────────────────

comments.post('/comments', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  /*
   * A PICTURE WITH NO CAPTION IS A COMMENT.
   *
   * TV Time allowed it and the archive is full of them, which is why
   * `/v1/comments/import` has always accepted an empty body when a photograph
   * follows. This route did not, so the app could not do the one thing the
   * import proves people actually did.
   *
   * `has_image` is a PROMISE, and the app keeps it: the picture is uploaded
   * against the id this returns, and a failed upload takes the comment back
   * down (see `useCommentAttachment`). A promise broken by a crash between the
   * two leaves one empty comment, which the author can delete -- the trade for
   * not making somebody caption a photograph they wanted to post on its own.
   */
  const text = validateCommentBody(b.body, { allowEmpty: b.has_image === true });
  if (!text.ok) {
    return text.reason === 'too_long'
      ? fail(c, 400, 'too_large', 'A comment is at most 2,000 characters.')
      : fail(c, 400, 'invalid_body', 'body is required.');
  }

  const db = c.env.DB;
  const me = c.get('profileId');
  const now = new Date();
  const nowIso = now.toISOString();

  // Per-user write cap, counted in D1 where the data already lives. This is
  // the limit that actually matters — abuse is per-account, not per-IP
  // (docs/IMPLEMENTATION.md, "Rate limiting"). The same statement answers
  // "does this profile still exist", so the cap costs no extra round trip.
  const since = new Date(now.getTime() - 3600_000).toISOString();
  const gate = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM comments WHERE author_id = ? AND created_at > ?) AS n,
              (SELECT COUNT(*) FROM profiles WHERE id = ? AND deleted_at IS NULL) AS alive`,
    )
    .bind(me, since, me)
    .first<{ n: number; alive: number }>();
  if (!gate || gate.alive === 0) return fail(c, 401, 'unauthenticated', 'No such profile.');
  if (gate.n >= COMMENTS_PER_HOUR) {
    return fail(c, 429, 'rate_limited', 'Too many comments in the last hour.');
  }

  // Season and episode are the same space ratings address, and are rejected
  // the same way.
  const season = numberOrNull(b.season);
  if (season === undefined) return fail(c, 400, 'invalid_body', 'season must be a non-negative integer.');
  const episode = numberOrNull(b.episode);
  if (episode === undefined) return fail(c, 400, 'invalid_body', 'episode must be a non-negative integer.');

  let targetSource: string;
  let targetKey: string;
  let targetSeason: number | null = season;
  let targetEpisode: number | null = episode;
  let parentId: string | null = null;
  let parentAuthor: string | null = null;

  if (b.parent_id !== null && b.parent_id !== undefined) {
    if (typeof b.parent_id !== 'string') return fail(c, 400, 'invalid_body', 'parent_id must be a string.');
    const parent = await db
      .prepare(
        `SELECT id, author_id, parent_id, target_source, target_key, season, episode
         FROM comments WHERE id = ? AND deleted_at IS NULL AND hidden_at IS NULL`,
      )
      .bind(b.parent_id)
      .first<{
        id: string;
        author_id: string;
        parent_id: string | null;
        target_source: string;
        target_key: string;
        season: number | null;
        episode: number | null;
      }>();

    // One level only (docs/PLAN.md §3). A reply to a reply is refused, not
    // silently re-parented — the client that sent it is wrong and must hear so.
    if (!replyDepthOk(parent)) {
      return fail(c, 400, 'invalid_body', 'Replies are one level deep, and the parent must exist.');
    }
    parentId = parent!.id;
    parentAuthor = parent!.author_id;
    // A reply INHERITS its parent's target. The client's is ignored entirely:
    // a reply that lands on a different episode than the comment it answers is
    // a thread that can never be read back.
    targetSource = parent!.target_source;
    targetKey = parent!.target_key;
    targetSeason = parent!.season;
    targetEpisode = parent!.episode;
  } else {
    if (!isTargetSource(b.target_source)) {
      return fail(c, 400, 'target_invalid', 'target_source must be tvdb, tmdb or title.');
    }
    if (typeof b.target_key !== 'string' || b.target_key.length === 0) {
      return fail(c, 400, 'target_invalid', 'target_key is required.');
    }
    targetSource = b.target_source;
    targetKey = b.target_key;
  }

  // The name rides along with the write, if the phone sent one. See
  // `rememberTitleName`: first writer wins, it never fails this request, and
  // it costs nothing when no title was sent.
  await rememberTitleName(c.env.DB, targetSource, targetKey, b.title);

  if (b.is_spoiler !== undefined && typeof b.is_spoiler !== 'boolean' && b.is_spoiler !== 0 && b.is_spoiler !== 1) {
    return fail(c, 400, 'invalid_body', 'is_spoiler must be a boolean.');
  }
  const isSpoiler = b.is_spoiler === true || b.is_spoiler === 1 ? 1 : 0;

  // Stamped from the body if it is a valid tag, otherwise from Accept-Language,
  // otherwise NULL. Never guessed from the text.
  const lang = isValidBcp47(b.lang) ? b.lang : firstAcceptLanguage(c.req.header('Accept-Language'));

  const id = newCommentId();
  const statements = [
    db
      .prepare(
        `INSERT INTO comments
           (id, author_id, target_source, target_key, season, episode, body, is_spoiler, lang, parent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        me,
        targetSource,
        targetKey,
        targetSeason,
        targetEpisode,
        text.body,
        isSpoiler,
        lang,
        parentId,
        nowIso,
      ),
  ];

  // The reply notification rides in the same batch as the comment: written by
  // the handler that causes it, never by a job. Never to yourself.
  if (parentId && parentAuthor && shouldNotify(me, parentAuthor)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO notifications (id, recipient_id, actor_id, kind, subject_type, subject_id, created_at)
           VALUES (?, ?, ?, 'reply', 'comment', ?, ?)`,
        )
        .bind(newNotificationId(), parentAuthor, me, id, nowIso),
    );
  }

  await db.batch(statements);

  // AFTER the batch, so nothing is delivered for a row that failed to write.
  if (parentId && parentAuthor && shouldNotify(me, parentAuthor)) {
    c.executionCtx.waitUntil(sendPush(c.env, parentAuthor, me, 'reply', id));
  }

  const row = await db
    .prepare(
      `SELECT ${COMMENT_COLUMNS} FROM comments c JOIN profiles p ON p.id = c.author_id ${IMAGE_JOIN} WHERE c.id = ?`,
    )
    .bind(id)
    .first<CommentRow>();

  return c.json(shapeComment(row!, me), 201);
});

// ── GET /v1/comments — open, block-aware when a bearer is present ────────────

comments.get('/comments', async (c) => {
  const url = new URL(c.req.url);
  const parentId = url.searchParams.get('parent_id');
  const limit = pageSize(url.searchParams.get('limit'));
  const cursor = parseCursor(url.searchParams.get('cursor'));

  // No `requireAuth`: a thread is readable by anybody. A bearer, when one is
  // present, buys `liked_by_me` and the block filter — and a bad token simply
  // reads as anonymous rather than 401ing a public page.
  const me = await optionalViewer(c.env, c.req.header('Authorization'));

  // Binds are assembled in PLACEHOLDER ORDER, not in logical order: the
  // liked_by_me sub-select is the first `?` in the statement, the target
  // conditions follow, then the two block binds, then the cursor, then LIMIT.
  const where: string[] = ['c.deleted_at IS NULL', 'c.hidden_at IS NULL', 'p.deleted_at IS NULL'];
  const targetBinds: (string | number)[] = [];
  const cursorBinds: (string | number)[] = [];

  if (parentId) {
    where.unshift('c.parent_id = ?');
    targetBinds.push(parentId);
  } else {
    if (!isTargetSource(url.searchParams.get('source'))) {
      return fail(c, 400, 'target_invalid', 'source must be tvdb, tmdb or title.');
    }
    const key = url.searchParams.get('key');
    if (!key) return fail(c, 400, 'target_invalid', 'key is required.');
    const seasonRaw = url.searchParams.get('season');
    const episodeRaw = url.searchParams.get('episode');
    const season = seasonRaw === null ? -1 : Number(seasonRaw);
    const episode = episodeRaw === null ? -1 : Number(episodeRaw);
    if (!Number.isInteger(season) || season < -1 || !Number.isInteger(episode) || episode < -1) {
      return fail(c, 400, 'target_invalid', 'season and episode must be non-negative integers.');
    }
    where.unshift(
      'c.target_source = ?',
      'c.target_key = ?',
      'COALESCE(c.season, -1) = ?',
      'COALESCE(c.episode, -1) = ?',
      'c.parent_id IS NULL',
    );
    targetBinds.push(url.searchParams.get('source')!, key, season, episode);
  }

  where.push(NOT_BLOCKED);

  if (cursor) {
    // A row value, not two ORed comparisons: (created_at, id) is a TOTAL order,
    // and an imported seeding batch writes hundreds of rows in the same second.
    // `created_at` alone would skip or repeat rows at every page boundary.
    where.push('(c.created_at, c.id) < (?, ?)');
    cursorBinds.push(cursor.createdAt, cursor.id);
  }

  // A reply count on a top-level item only. Replies come from ?parent_id=, so a
  // 200-reply argument never lands in one payload.
  //
  // It carries the SAME block filter as the page itself: "2 replies" followed
  // by a page showing one is a bug report, and worse, it tells the reader that
  // somebody they blocked is still talking.
  const replyCount = parentId
    ? '0 AS reply_count'
    : `(SELECT COUNT(*) FROM comments r
        WHERE r.parent_id = c.id AND r.deleted_at IS NULL AND r.hidden_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM blocks rb
                          WHERE (rb.blocker_id = ? AND rb.blocked_id = r.author_id)
                             OR (rb.blocker_id = r.author_id AND rb.blocked_id = ?))) AS reply_count`;
  const replyCountBinds = parentId ? [] : [me, me];

  // limit + 1: the extra row is how `next_cursor` knows it is not the last page
  // without a second count.
  const res = await c.env.DB.prepare(
    `SELECT ${COMMENT_COLUMNS},
            EXISTS(SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = ?) AS liked_by_me,
            ${replyCount}
     FROM comments c JOIN profiles p ON p.id = c.author_id ${IMAGE_JOIN}
     WHERE ${where.join(' AND ')}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ?`,
  )
    .bind(me, ...replyCountBinds, ...targetBinds, me, me, ...cursorBinds, limit + 1)
    .all<CommentRow>();

  const rows = res.results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? makeCursor(last.created_at, last.id) : null;

  // Explicit rather than point-free: `.map(shapeComment)` passes the INDEX
  // as the viewer, which typechecks as nothing and reveals nothing, but only
  // by accident.
  return c.json({ items: page.map((r) => shapeComment(r, me)), next_cursor: nextCursor });
});

// ── GET /v1/comments/:id — one comment, open, block-aware ───────────────────
//
// A `reply` or `like` notification carries `subject_id` and nothing else, so
// tapping it had no way to open the thread it belongs to. This is that lookup.
//
// It honours the thread read's rules to the letter — deleted, hidden, an author
// whose account is gone, a block in either direction — and answers 404 for all
// of them. Anything else would turn a notification into an oracle: "this
// comment still exists, it is merely hidden from you" is exactly what a hide
// and a block are meant not to say.

comments.get('/comments/:id', async (c) => {
  const me = await optionalViewer(c.env, c.req.header('Authorization'));

  const row = await c.env.DB.prepare(
    `SELECT ${COMMENT_COLUMNS},
            EXISTS(SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = ?) AS liked_by_me,
            (SELECT COUNT(*) FROM comments r
              WHERE r.parent_id = c.id AND r.deleted_at IS NULL AND r.hidden_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM blocks rb
                                WHERE (rb.blocker_id = ? AND rb.blocked_id = r.author_id)
                                   OR (rb.blocker_id = r.author_id AND rb.blocked_id = ?))) AS reply_count
     FROM comments c JOIN profiles p ON p.id = c.author_id ${IMAGE_JOIN}
     WHERE c.id = ? AND c.deleted_at IS NULL AND c.hidden_at IS NULL AND p.deleted_at IS NULL
       AND ${NOT_BLOCKED}`,
  )
    .bind(me, me, me, c.req.param('id'), me, me)
    .first<CommentRow>();

  if (!row) return fail(c, 404, 'not_found', 'No such comment.');
  return c.json(shapeComment(row, me));
});

// ── DELETE /v1/comments/:id ──────────────────────────────────────────────────

comments.delete('/comments/:id', requireAuth, async (c) => {
  const res = await c.env.DB.prepare(
    'UPDATE comments SET deleted_at = ? WHERE id = ? AND author_id = ? AND deleted_at IS NULL',
  )
    .bind(new Date().toISOString(), c.req.param('id'), c.get('profileId'))
    .run();

  // 403, not 404: a missing id and someone else's id must be indistinguishable,
  // or DELETE becomes an oracle for which comment ids exist. Replies survive
  // with a tombstone parent — the lesser evil against cascading a conversation
  // out of existence.
  if (res.meta.changes === 0) return fail(c, 403, 'forbidden', 'Not your comment.');
  // And off CommsUni, if it was shared there (§10: author deletes).
  c.executionCtx.waitUntil(unshareComment(c.env, c.get('profileId'), c.req.param('id')));
  return c.body(null, 204);
});

// ── likes ────────────────────────────────────────────────────────────────────
//
// The counter is denormalised onto `comments`; `comment_likes` is the stated
// source of truth (docs/schema.dbml), and the Step 5 job reconciles the two.
// Drift here is expected and cheap; a double-tap inflating a count is not,
// which is what the `meta.changes` guard below is for.
//
// The insert runs ALONE and the rest as a batch, because a batch cannot branch
// on a result: "skip the second statement when changes is 0" is only
// expressible as two round trips.

comments.post('/comments/:id/like', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();

  const target = await db
    .prepare('SELECT author_id FROM comments WHERE id = ? AND deleted_at IS NULL AND hidden_at IS NULL')
    .bind(id)
    .first<{ author_id: string }>();
  if (!target) return fail(c, 404, 'not_found', 'No such comment.');

  const inserted = await db
    .prepare('INSERT OR IGNORE INTO comment_likes (comment_id, user_id, created_at) VALUES (?, ?, ?)')
    .bind(id, me, nowIso)
    .run();

  if (inserted.meta.changes > 0) {
    const statements = [
      db.prepare('UPDATE comments SET like_count = like_count + 1 WHERE id = ?').bind(id),
    ];
    // On the insert path only, and never to yourself.
    if (shouldNotify(me, target.author_id)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO notifications (id, recipient_id, actor_id, kind, subject_type, subject_id, created_at)
             VALUES (?, ?, ?, 'like', 'comment', ?, ?)`,
          )
          .bind(newNotificationId(), target.author_id, me, id, nowIso),
      );
    }
    await db.batch(statements);
    // After the batch — never deliver for a row that failed to write.
    if (shouldNotify(me, target.author_id)) {
      c.executionCtx.waitUntil(sendPush(c.env, target.author_id, me, 'like', id));
    }
  }

  const row = await db
    .prepare('SELECT like_count FROM comments WHERE id = ?')
    .bind(id)
    .first<{ like_count: number }>();
  return c.json({ liked: true, like_count: row?.like_count ?? 0 });
});

comments.delete('/comments/:id/like', requireAuth, async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');

  const removed = await db
    .prepare('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?')
    .bind(id, c.get('profileId'))
    .run();

  if (removed.meta.changes > 0) {
    // MAX(…, 0): a counter that has already drifted low must not go negative
    // and hand the Step 5 job a number it cannot explain.
    await db
      .prepare('UPDATE comments SET like_count = MAX(like_count - 1, 0) WHERE id = ?')
      .bind(id)
      .run();
  }

  const row = await db
    .prepare('SELECT like_count FROM comments WHERE id = ?')
    .bind(id)
    .first<{ like_count: number }>();
  if (!row) return fail(c, 404, 'not_found', 'No such comment.');
  return c.json({ liked: false, like_count: row.like_count });
});

// ── POST /v1/comments/import/delete ─────────────────────────────────────────

/**
 * Delete a comment the phone knows only as an ARCHIVE ROW.
 *
 * WHY THIS ROUTE HAS TO EXIST. Deleting an imported comment used to write a
 * tombstone in local storage and nothing else: the row vanished from that phone
 * and stayed on the public profile and in the thread, for everyone. The button
 * said "Delete comment" and meant "hide on this device", which is the wrong
 * promise to break -- somebody removing something they wrote nine years ago is
 * usually removing it from OTHER PEOPLE.
 *
 * It could not simply call `DELETE /v1/comments/:id`, because the local row has
 * no server id. Seeded comments are addressed by a HASH of what they are
 * (author, target, season, episode, date, body), computed here -- and the
 * codebase deliberately refuses to reimplement that hash on the phone, for the
 * reason `images.ts` gives: a second copy is one refactor away from silently
 * addressing the wrong rows.
 *
 * So this takes the same fields the seeder already sends and derives the same
 * id from them, exactly as the image upload does. The phone sends what it
 * knows; the server works out which comment that is.
 *
 * NOT FOUND IS A SUCCESS. A comment that was never seeded, or already deleted,
 * leaves nothing to do -- and an error there would put a failure in front of
 * somebody whose comment is, as far as they can tell, gone. `deleted` says
 * which happened, for a caller that cares.
 */
comments.post('/comments/import/delete', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const targetSource = String(b.target_source ?? '');
  const targetKey = String(b.target_key ?? '').trim();
  const createdAt = String(b.created_at ?? '');
  if (!['tvdb', 'tmdb', 'title'].includes(targetSource) || !targetKey || !createdAt) {
    return fail(c, 400, 'invalid_body', 'target_source, target_key and created_at are required.');
  }

  const me = c.get('profileId');
  const id = await stableImportId({
    authorId: me,
    targetSource,
    targetKey,
    season: typeof b.season === 'number' ? b.season : null,
    episode: typeof b.episode === 'number' ? b.episode : null,
    createdAt,
    body: String(b.body ?? ''),
  });

  /*
   * `author_id = ?` is not belt-and-braces. The id is derived FROM the caller's
   * own id, so it can only ever name one of their comments -- but the row is
   * checked anyway, because that reasoning is a property of a hash somewhere
   * else and this is the line that would have to be right if it ever changed.
   */
  const res = await c.env.DB.prepare(
    'UPDATE comments SET deleted_at = ? WHERE id = ? AND author_id = ? AND deleted_at IS NULL',
  )
    .bind(new Date().toISOString(), id, me)
    .run();

  return c.json({ ok: true, deleted: (res.meta?.changes ?? 0) > 0, comment_id: id });
});
