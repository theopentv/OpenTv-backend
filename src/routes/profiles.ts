import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import {
  handlePrefixPattern,
  makeCursor,
  normaliseHandle,
  pageSize,
  parseCursor,
  parseHiddenSections,
  plusOn,
  sectionHidden,
  USER_SEARCH_LIMIT,
  visibleProfileFields,
  publicCoverFrame,
} from '@/pure';
import { COMMENT_COLUMNS, IMAGE_JOIN, optionalViewer, shapeComment, type CommentRow } from '@/routes/comments';
import { edgePage } from '@/routes/follows';

/**
 * Public profiles and the lists hanging off them.
 * docs/IMPLEMENTATION.md Step 4, "GET /v1/profiles/:handle".
 *
 * Open routes: `requireAuth` is deliberately not mounted. A bearer, when one
 * is present, buys `followed_by_me`, the private-profile fields the viewer has
 * earned, and the block filter — and a bad token reads as anonymous rather
 * than 401ing a public page, exactly as the thread read does.
 *
 * DEVIATION, recorded because the plan is silent on it: a profile is 404 to
 * anyone it has blocked AND to anyone who has blocked it. 404 rather than 403
 * because 403 confirms the account exists, and a blocked person learning "yes,
 * they are still here, and yes, they blocked you" is precisely the interaction
 * a block is meant to end.
 */

export const profiles = new Hono<App>();

type ProfileReadRow = {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  cover_url: string | null;
  theme_color: string | null;
  theme_layout: string | null;
  cover_frame: string | null;
  widgets: string | null;
  bio: string | null;
  is_private: number;
  links: string | null;
  plus_until: string | null;
  is_plus: number;
  hidden_sections: string | null;
  created_at: string;
  followers: number;
  following: number;
  comments: number;
  lists: number;
  followed_by_me: number;
  follow_requested_by_me: number;
  blocked: number;
};

function parseLinks(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Lookup is on `handle_lower`, ALWAYS — the handle a user types, or a friend
 * pastes into a chat, is not case-correct.
 *
 * The counts, `followed_by_me` and the block test all ride in the same
 * statement: a profile screen is one round trip or it is a spinner.
 */
export async function readProfile(env: Env, handle: string, viewer: string): Promise<ProfileReadRow | null> {
  return env.DB.prepare(
    `SELECT p.id, p.handle, p.display_name, p.avatar_key, p.cover_url, p.cover_frame, p.theme_color, p.theme_layout, p.widgets, p.bio, p.is_private, p.links,
            p.plus_until, p.is_plus, p.hidden_sections, p.created_at,
            -- ACCEPTED ONLY, in all four. A pending request is a question, and
            -- counting it would make "12 followers" mean "9 followers and 3
            -- people who asked" — and followed_by_me is worse than wrong: it
            -- is the gate maySeeDetail opens the private half of the profile
            -- with, so an unfiltered read would let anybody who tapped Follow
            -- straight past the thing they were asking permission for.
            (SELECT COUNT(*) FROM follows f WHERE f.followee_id = p.id AND f.state = 'accepted') AS followers,
            (SELECT COUNT(*) FROM follows f WHERE f.follower_id = p.id AND f.state = 'accepted') AS following,
            (SELECT COUNT(*) FROM comments c
              WHERE c.author_id = p.id AND c.deleted_at IS NULL AND c.hidden_at IS NULL
                AND c.parent_id IS NULL AND c.tvtime_parent_id IS NULL) AS comments,
            (SELECT COUNT(*) FROM lists l WHERE l.owner_id = p.id AND l.is_public = 1)
              + (SELECT COUNT(*) FROM shared_list_members m
                   JOIN shared_lists sl ON sl.id = m.list_id
                  WHERE m.member_id = p.id AND sl.deleted_at IS NULL) AS lists,
            EXISTS(SELECT 1 FROM follows f
                    WHERE f.follower_id = ? AND f.followee_id = p.id AND f.state = 'accepted') AS followed_by_me,
            EXISTS(SELECT 1 FROM follows f
                    WHERE f.follower_id = ? AND f.followee_id = p.id AND f.state = 'pending') AS follow_requested_by_me,
            EXISTS(SELECT 1 FROM blocks b
                   WHERE (b.blocker_id = ? AND b.blocked_id = p.id)
                      OR (b.blocker_id = p.id AND b.blocked_id = ?)) AS blocked
     FROM profiles p
     WHERE p.handle_lower = ? AND p.deleted_at IS NULL
       -- An account only has no public profile (0049); its owner still sees theirs.
       AND (p.joined_at IS NOT NULL OR p.id = ?)`,
  )
    .bind(viewer, viewer, viewer, viewer, normaliseHandle(handle), viewer)
    .first<ProfileReadRow>();
}

/** `lists` counts PUBLIC lists only — a private list must not be inferable from a number. */
export function shapeProfile(row: ProfileReadRow, viewer: string, nowIso: string) {
  // THE COUNT GOES WITH THE SECTION. The two counts that stand over a hidden
  // section would otherwise announce exactly what the owner asked not to show —
  // "88 comments" above nothing is a worse gap than no number at all, and it is
  // still a disclosure. The owner keeps their own numbers.
  const owns = row.id === viewer;
  const hidden = (key: 'comments' | 'lists') => !owns && sectionHidden(row.hidden_sections, key);

  return visibleProfileFields(
    {
      id: row.id,
      handle: row.handle,
      display_name: row.display_name,
      avatar_key: row.avatar_key,
      cover_url: row.cover_url,
      /**
       * THE THEME STOPS APPLYING WHEN THE SUBSCRIPTION DOES, and it is nulled
       * HERE rather than deleted from the row. The stored choice survives, so
       * resubscribing restores the profile instead of asking somebody to pick
       * it all over again as a penalty for having lapsed.
       *
       * Nulled on the way out rather than left to the app: a lapsed member's
       * theme reaching every visitor's phone is the server publishing a paid
       * look for somebody who is not paying, and the app cannot be the only
       * thing standing between the two -- there are older builds out there that
       * will render whatever this sends, for ever.
       */
      theme_color: plusOn(row, nowIso) ? row.theme_color : null,
      theme_layout: plusOn(row, nowIso) ? row.theme_layout : null,
      cover_frame: publicCoverFrame(row.cover_frame ?? null, plusOn(row, nowIso)),
      /*
       * The arrangement, and the SAME Plus rule as the colour and the layout —
       * for the same reason, spelled out three lines above: older builds will
       * render whatever this sends, for ever, so a lapsed subscription has to
       * stop being paid-for HERE rather than in an app that may never update.
       *
       * Sent as the stored string. Parsing it is the app's job because the app
       * owns what a widget means; this route's contract is only that a profile
       * either has an arrangement or does not.
       */
      widgets: plusOn(row, nowIso) ? row.widgets : null,
      bio: row.bio,
      is_private: row.is_private === 1,
      links: parseLinks(row.links),
      // A boolean, never the date (docs/IMPLEMENTATION.md Step 4).
      is_plus: plusOn(row, nowIso),
      counts: {
        followers: row.followers,
        following: row.following,
        comments: hidden('comments') ? 0 : row.comments,
        lists: hidden('lists') ? 0 : row.lists,
      },
      followed_by_me: row.followed_by_me === 1,
      follow_requested_by_me: row.follow_requested_by_me === 1,
      hidden_sections: parseHiddenSections(row.hidden_sections),
      created_at: row.created_at,
    },
    row.followed_by_me === 1,
    row.id === viewer,
  );
}

/** Whether this viewer has earned the private side: themselves, or an accepted follower. */
function maySeeDetail(row: ProfileReadRow, viewer: string): boolean {
  return row.is_private === 0 || row.id === viewer || row.followed_by_me === 1;
}

// ── GET /v1/users?q= — find a person by handle ──────────────────────────────
//
// The one endpoint the app needs before anything social is usable: you cannot
// follow someone you cannot find, and until now the only way to reach a profile
// was to already know its exact handle.
//
// A PREFIX search, deliberately — see `handlePrefixPattern` for why `%q%` is not
// on the table and why the `_` in every placeholder handle has to be escaped.
// Display names are NOT searched: they are unvalidated free text, they are not
// indexed, and a search that matched them would be a table scan that also let
// someone find a private account by the name they chose for their friends.

type UserSearchRow = {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  is_private: number;
  is_plus: number;
  plus_until: string | null;
};

profiles.get('/users', async (c) => {
  const pattern = handlePrefixPattern(new URL(c.req.url).searchParams.get('q'));
  if (!pattern) return fail(c, 400, 'invalid_body', 'q is required.');

  // Open route; the bearer is optional and buys only the block filter. A bad
  // token reads as anonymous rather than 401ing a public search.
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));

  const res = await c.env.DB.prepare(
    `SELECT p.id, p.handle, p.display_name, p.avatar_key, p.is_private, p.is_plus, p.plus_until
       FROM profiles p
      -- NAME AS WELL AS HANDLE. A handle is a slug — "Mahmood Bashar" becomes
      -- @mahmood_bashar — so somebody typing the name they actually know finds
      -- nobody. The display name is the string people recognise each other by,
      -- and searching only the slug made the community feel emptier than it is.
      WHERE (p.handle_lower LIKE ? ESCAPE '\\'
             OR LOWER(COALESCE(p.display_name, '')) LIKE ? ESCAPE '\\')
        AND p.deleted_at IS NULL
        -- MEMBERS ONLY: an account made for backup and sync is nobody's to find.
        AND p.joined_at IS NOT NULL
        -- YOURSELF IS NOT SOMEBODY TO FOLLOW. IS NOT rather than != on
        -- purpose: the viewer is NULL for an anonymous search, and p.id != NULL
        -- evaluates to NULL rather than TRUE, which would empty every
        -- signed-out search.
        AND p.id IS NOT ?
        AND NOT EXISTS (SELECT 1 FROM blocks b
                        WHERE (b.blocker_id = ? AND b.blocked_id = p.id)
                           OR (b.blocker_id = p.id AND b.blocked_id = ?))
      ORDER BY p.handle_lower
      LIMIT ?`,
  )
    .bind(pattern, pattern, viewer, viewer, viewer, USER_SEARCH_LIMIT)
    .all<UserSearchRow>();

  // The shell only. A search result is a row in a list, not a profile — counts,
  // bio and links stay behind `GET /v1/profiles/:handle` and its privacy matrix.
  // `is_plus` rides along with the shell, unlike everything else behind the
  // privacy matrix: the badge is drawn next to the name wherever the name
  // appears, and a badge that shows on the profile and not in the list it was
  // opened from reads as a bug.
  const nowIso = new Date().toISOString();
  return c.json({
    items: (res.results ?? []).map((r) => ({
      id: r.id,
      handle: r.handle,
      display_name: r.display_name,
      avatar_key: r.avatar_key,
      is_private: r.is_private === 1,
      is_plus: plusOn(r, nowIso),
    })),
  });
});

// ── GET /v1/profiles/:handle ────────────────────────────────────────────────

profiles.get('/profiles/:handle', async (c) => {
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));
  const row = await readProfile(c.env, c.req.param('handle'), viewer);

  // A soft-deleted profile is gone, not a tombstone.
  if (!row) return fail(c, 404, 'not_found', 'No such profile.');
  if (row.blocked === 1) return fail(c, 404, 'not_found', 'No such profile.');

  return c.json(shapeProfile(row, viewer, new Date().toISOString()));
});

// ── GET /v1/profiles/:handle/followers ──────────────────────────────────────

profiles.get('/profiles/:handle/followers', async (c) => {
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));
  const row = await readProfile(c.env, c.req.param('handle'), viewer);
  if (!row || row.blocked === 1) return fail(c, 404, 'not_found', 'No such profile.');

  // The same rule the counts follow: a private profile's follower list is part
  // of the detail, not part of the shell.
  if (!maySeeDetail(row, viewer)) return fail(c, 403, 'forbidden', 'This profile is private.');

  return c.json(
    await edgePage(
      c.env.DB,
      'followee_id',
      'follower_id',
      row.id,
      new URL(c.req.url).searchParams.get('cursor'),
    ),
  );
});

// ── GET /v1/profiles/:handle/following ──────────────────────────────────────

/**
 * Who this person follows — the mirror of the route above, and it did not
 * exist.
 *
 * WHY IT HAD TO. A profile's count band says "12 following" and the number was
 * unopenable on anybody but yourself: the only following list the server
 * published was `/v1/me/following`. So somebody else's profile had a count you
 * could read and not follow, while your own opened. Two profiles, two
 * behaviours, one design — which is the thing the shared profile template
 * exists to stop.
 *
 * IDENTICAL VISIBILITY to the followers list, deliberately: a 404 for a handle
 * that is absent, deleted or blocked in either direction, and a 403 for a
 * private profile you do not follow. Who somebody follows is exactly as
 * revealing as who follows them, so it cannot be the softer of the two.
 */
profiles.get('/profiles/:handle/following', async (c) => {
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));
  const row = await readProfile(c.env, c.req.param('handle'), viewer);
  if (!row || row.blocked === 1) return fail(c, 404, 'not_found', 'No such profile.');
  if (!maySeeDetail(row, viewer)) return fail(c, 403, 'forbidden', 'This profile is private.');

  // The columns swap round: a follower row matches on `followee_id` and yields
  // the follower; a following row matches on `follower_id` and yields the
  // followee. Same helper, same cursor, same page size.
  return c.json(
    await edgePage(
      c.env.DB,
      'follower_id',
      'followee_id',
      row.id,
      new URL(c.req.url).searchParams.get('cursor'),
    ),
  );
});

// ── GET /v1/profiles/:handle/lists ──────────────────────────────────────────

type ListRow = {
  id: string;
  name: string;
  description: string | null;
  is_public: number;
  created_at: string;
  item_count: number;
  shared?: number;
  member_count?: number | null;
};

function shapeList(row: ListRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    is_public: row.is_public === 1,
    item_count: row.item_count,
    created_at: row.created_at,
    /**
     * A shared list is flagged rather than disguised as an ordinary one.
     *
     * The two are not the same object and must not look it: this one has other
     * people in it, its id belongs to `shared_lists`, and opening it goes
     * through a different route. The app needs to know which before it can
     * route a tap correctly, so the distinction travels with the row.
     */
    shared: row.shared === 1,
    member_count: row.shared === 1 ? row.member_count : null,
  };
}

profiles.get('/profiles/:handle/lists', async (c) => {
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));
  const row = await readProfile(c.env, c.req.param('handle'), viewer);
  if (!row || row.blocked === 1) return fail(c, 404, 'not_found', 'No such profile.');
  if (!maySeeDetail(row, viewer)) return fail(c, 403, 'forbidden', 'This profile is private.');

  // HIDDEN MEANS ABSENT, not "the app knows not to draw it". A section the
  // server still serves is hidden from a screen and from nobody else, and the
  // owner was told it was hidden. 200 with nothing rather than 403: the
  // section is not forbidden, it is empty, and `hidden_sections` on the profile
  // already says why.
  if (row.id !== viewer && sectionHidden(row.hidden_sections, 'lists')) {
    return c.json({ items: [] });
  }

  // Public lists only, even for the owner: this is the shop window, and an
  // owner who wants their drafts has `GET /v1/lists/:id` for each.
  //
  // ORDERED BY THE OWNER'S OWN ARRANGEMENT. This sorted newest-first, so the
  // drag-to-reorder on the Lists screen changed nothing anybody else could see.
  // `created_at` still breaks ties, for rows published before `position`
  // existed — they all default to 0.
  const res = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.description, l.is_public, l.created_at,
            (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS item_count,
            0 AS shared, NULL AS member_count
     FROM lists l
     WHERE l.owner_id = ? AND l.is_public = 1
     ORDER BY l.position ASC, l.created_at DESC, l.id DESC`,
  )
    .bind(row.id)
    .all<ListRow>();

  /**
   * THE SHARED LISTS THIS PERSON IS IN — on every member's profile, not the
   * owner's alone.
   *
   * A shared list has no single author. Three people fill it and one of them
   * happened to press the button first; putting it on that one profile would
   * credit one person for everybody's work and leave the other two with
   * nothing to show for a list they built. So membership is what puts it on a
   * profile, and it appears on all of theirs at once.
   *
   * `is_public` has no equivalent here and is not wanted: an ordinary list is
   * one person's, so it needs a switch saying whether the world may see it. A
   * shared list is already an agreement between several people to share, and a
   * per-member switch would mean the same list is public on one profile and
   * hidden on another — one member could quietly reveal what another was
   * hiding. The `hidden_sections` lists flag still removes the whole shelf for
   * anybody who wants none of it.
   *
   * Ordered after the ordinary lists and by joining time: they have no
   * `position`, because there is no single owner to arrange them.
   */
  const shared = await c.env.DB.prepare(
    `SELECT sl.id, sl.name, NULL AS description, 1 AS is_public, sl.created_at,
            (SELECT COUNT(*) FROM shared_list_items i WHERE i.list_id = sl.id) AS item_count,
            1 AS shared,
            (SELECT COUNT(*) FROM shared_list_members m2 WHERE m2.list_id = sl.id) AS member_count
     FROM shared_list_members m
     JOIN shared_lists sl ON sl.id = m.list_id
     WHERE m.member_id = ? AND sl.deleted_at IS NULL
     ORDER BY m.joined_at DESC, sl.id DESC`,
  )
    .bind(row.id)
    .all<ListRow>();

  return c.json({ items: [...(res.results ?? []), ...(shared.results ?? [])].map(shapeList) });
});

// ── GET /v1/profiles/:handle/comments ───────────────────────────────────────

/**
 * Everything one person has said, newest first.
 *
 * WHY IT DID NOT EXIST AND HAD TO. `GET /v1/comments` can only fetch a THREAD —
 * it wants a target, or a parent. So a profile could show "2 comments" as a
 * number and had no way on earth to show the two comments; the screen rendered
 * a count band over an empty page. For an app whose first act is importing
 * seven years of someone's writing, "your words are here, you may not read
 * them" is the wrong sentence to ship.
 *
 * THE SAME VISIBILITY RULES AS THE THREAD, to the letter: deleted, hidden, an
 * author whose account is gone, and a block in either direction all remove a
 * row here exactly as they do there. A profile must never become the back door
 * to a comment the thread would not show.
 *
 * REPLIES ARE NOT INCLUDED, and neither are they counted.
 *
 * They used to be, on the reasoning that they are things this person wrote. But
 * a reply is half of somebody else's conversation: torn out of its thread it
 * reads as a non-sequitur, and it drags a fragment of the parent's context onto
 * a stranger's screen. The owner's own Profile tab has always shown top-level
 * comments only, so a visitor also saw a number the owner could not reproduce —
 * 4 against their 2.
 *
 * `parent_id IS NULL` is the same test `getVisibleOwnComments()` makes on the
 * phone. One definition of "a comment on my profile", both ends.
 */
profiles.get('/profiles/:handle/comments', async (c) => {
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));
  const row = await readProfile(c.env, c.req.param('handle'), viewer);
  if (!row || row.blocked === 1) return fail(c, 404, 'not_found', 'No such profile.');
  if (!maySeeDetail(row, viewer)) return fail(c, 403, 'forbidden', 'This profile is private.');

  // The same rule the lists route follows: hidden is empty, for everybody but
  // the owner. The comments themselves are untouched and still appear in the
  // threads they were written in — this hides the FEED of somebody's writing,
  // which is the thing that reads as a diary, not each remark.
  if (row.id !== viewer && sectionHidden(row.hidden_sections, 'comments')) {
    return c.json({ items: [], next_cursor: null });
  }

  const url = new URL(c.req.url);
  const limit = pageSize(url.searchParams.get('limit'));
  const cursor = parseCursor(url.searchParams.get('cursor'));

  const where = [
    'c.author_id = ?',
    'c.deleted_at IS NULL',
    'c.hidden_at IS NULL',
    'c.parent_id IS NULL',
    // An imported reply whose original is not here is still a reply, and the
    // owner's own tab (`type != 'reply'`) has never listed one.
    'c.tvtime_parent_id IS NULL',
    'p.deleted_at IS NULL',
  ];
  const binds: (string | number)[] = [row.id];
  if (cursor) {
    // A row value, for the reason the thread read gives: an imported seeding
    // batch writes hundreds of rows in the same second, so `created_at` alone
    // would skip or repeat rows at every page boundary.
    where.push('(c.created_at, c.id) < (?, ?)');
    binds.push(cursor.createdAt, cursor.id);
  }

  const res = await c.env.DB.prepare(
    // COMMENT_COLUMNS and IMAGE_JOIN, the same as every thread read. This feed
    // listed its own columns and left the picture out, so every comment on a
    // profile said "no image" — and the owner's other devices, which sync from
    // here, never learned of a picture approved for one of theirs (1 Oct).
    `SELECT ${COMMENT_COLUMNS},
            EXISTS(SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = ?) AS liked_by_me,
            -- COUNTED, not zero. It used to be hardcoded, on the reasoning
            -- that a profile feed is a list of what somebody wrote rather than
            -- a thread — but the card draws the number, so every comment on
            -- every profile claimed nobody had answered it, and the one route
            -- into a conversation looked like a dead end.
            --
            -- Same block filter as the thread's own count: "1 reply" leading to
            -- a page that shows none is a bug report, and worse, it tells the
            -- reader that somebody they blocked is still talking.
            (SELECT COUNT(*) FROM comments r
              WHERE r.parent_id = c.id AND r.deleted_at IS NULL AND r.hidden_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM blocks rb
                                WHERE (rb.blocker_id = ? AND rb.blocked_id = r.author_id)
                                   OR (rb.blocker_id = r.author_id AND rb.blocked_id = ?))) AS reply_count
     FROM comments c JOIN profiles p ON p.id = c.author_id ${IMAGE_JOIN}
     WHERE ${where.join(' AND ')}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ?`,
  )
    // `viewer` three times: once for `liked_by_me`, twice for the reply
    // count's block test. The order matches the placeholders above.
    .bind(viewer, viewer, viewer, ...binds, limit + 1)
    .all<CommentRow>();

  const rows = res.results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  // limit + 1: the extra row is how `next_cursor` knows it is not the last page.
  const nextCursor = rows.length > limit && last ? makeCursor(last.created_at, last.id) : null;

  return c.json({ items: page.map((r) => shapeComment(r, viewer)), next_cursor: nextCursor });
});

// ── GET /v1/lists/:id ───────────────────────────────────────────────────────

type ListDetailRow = ListRow & {
  owner_id: string;
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  is_plus: number;
  plus_until: string | null;
  blocked: number;
};

profiles.get('/lists/:id', async (c) => {
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));

  const row = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.description, l.is_public, l.created_at, l.owner_id,
            p.handle, p.display_name, p.avatar_key, p.is_plus, p.plus_until,
            0 AS item_count,
            EXISTS(SELECT 1 FROM blocks b
                   WHERE (b.blocker_id = ? AND b.blocked_id = p.id)
                      OR (b.blocker_id = p.id AND b.blocked_id = ?)) AS blocked
     FROM lists l JOIN profiles p ON p.id = l.owner_id
     WHERE l.id = ? AND p.deleted_at IS NULL`,
  )
    .bind(viewer, viewer, c.req.param('id'))
    .first<ListDetailRow>();

  // Every refusal here is the same 404: a private list, a list belonging to a
  // deleted account, a list belonging to someone who blocked you and a list
  // that never existed must be indistinguishable, or the id space becomes an
  // oracle.
  if (!row || row.blocked === 1) return fail(c, 404, 'not_found', 'No such list.');
  if (row.is_public !== 1 && row.owner_id !== viewer) return fail(c, 404, 'not_found', 'No such list.');

  // Ordered by position, with the DENORMALISED title: rendering a list must
  // not require a metadata lookup, which is the entire reason `title` is
  // stored on the item.
  // `poster` alongside the title, for the same reason: a collage that has to
  // resolve artwork before it can draw is a collage of grey rectangles, and the
  // server has no catalogue to resolve it FROM — the publishing phone does.
  const items = await c.env.DB.prepare(
    `SELECT position, target_source, target_key, title, poster
     FROM list_items WHERE list_id = ? ORDER BY position`,
  )
    .bind(row.id)
    .all<{
      position: number;
      target_source: string;
      target_key: string;
      title: string | null;
      poster: string | null;
    }>();

  const results = items.results ?? [];
  return c.json({
    ...shapeList({ ...row, item_count: results.length }),
    owner: {
      id: row.owner_id,
      handle: row.handle,
      display_name: row.display_name,
      avatar_key: row.avatar_key,
      is_plus: plusOn(row, new Date().toISOString()),
    },
    items: results,
  });
});
