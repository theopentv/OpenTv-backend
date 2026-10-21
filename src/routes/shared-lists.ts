import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { hasPlus, requireAuth } from '@/middleware';
import { plusOn } from '@/pure';

/**
 * Lists two people build together.
 *
 * THE PAYWALL IS ON THE DOOR HANDLE, NOT THE DOOR. Past the first list,
 * STARTING one needs Plus. JOINING never does, at any tier, for ever — and that
 * is the design rather than a kindness: a list whose invitees must pay to
 * accept is a list of one person, and the member who paid has bought an empty
 * room. One subscription pulls three people into the app and they meet the
 * feature by using it.
 *
 * THE SERVER HOLDS THE TRUTH HERE, uniquely. Everywhere else it mirrors a
 * phone; two devices writing to one list means neither copy can be
 * authoritative without eating the other's edits. That stays inside the rule
 * the project rests on — a list two friends build together was never one
 * person's private history — and no route here touches anybody's library.
 */

export const sharedLists = new Hono<App>();

/** Past this, starting a new one is Plus. Joining is never capped. */
const FREE_OWNED_LISTS = 1;

const MAX_NAME = 60;
const MAX_ITEMS = 500;
const MAX_MEMBERS = 20;

/**
 * WATCHING TOGETHER (2.0.0, design §2) — a shared list of exactly one show
 * (`kind = 'together'`) whose tick became a position: each member's furthest
 * episode marked watched, one (season, episode) cursor in
 * `shared_list_positions`, overwritten, never a history (§0).
 *
 * PLUS, AND EXACTLY WHERE (D11). Only STARTING one needs Plus — `POST
 * /shared-lists` with `kind: 'together'`, every time, not past a free first.
 * Everything after that stays open at every tier, including for a creator
 * whose Plus has lapsed: join, both GETs, PUT/DELETE position, leave, delete,
 * rotate the invite. A lapse freezing a friend's progress strip would punish
 * the friend for somebody else's subscription.
 *
 * Invites are the existing code/link (D8), at most five people (D9), and
 * nothing here sends a push (D12) — the strip updates when it is opened.
 *
 * D1 PER ACTIVE MEMBER PER DAY: PUT position ≈ 3 rows read + 1 write, ≤ 3
 * sittings; GET detail ≈ 15 rows (list 1, members ≤ 5, items 1, positions ≤ 5,
 * plus the watched counts), ~5 opens; GET index ≈ 10 per list, once. About
 * 100 rows read and 3 writes, and zero requests when nothing changed.
 */
const MAX_TOGETHER_MEMBERS = 5;
const MAX_EPISODE_NUMBER = 9999;

type Kind = 'list' | 'together';
type TogetherShow = { target_source: 'tvdb'; target_key: string; title: string | null; poster: string | null };

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * An invite code, and it is deliberately not a UUID.
 *
 * It gets read aloud, typed by hand, and put in a message. So: ten characters
 * from an alphabet with no 0/O and no 1/I/l, which are the pairs people
 * actually mistype. `crypto.getRandomValues` rather than Math.random because a
 * guessable code is a way into somebody's list.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** The caller's role on a list, or null when they are not in it at all. */
async function roleOf(db: D1Database, listId: string, me: string): Promise<string | null> {
  return (await membershipOf(db, listId, me))?.role ?? null;
}

/** The caller's role and the list's kind, in the one read `roleOf` already makes. */
async function membershipOf(
  db: D1Database,
  listId: string,
  me: string,
): Promise<{ role: string; kind: Kind } | null> {
  return db
    .prepare(
      `SELECT m.role AS role, l.kind AS kind FROM shared_list_members m
         JOIN shared_lists l ON l.id = m.list_id AND l.deleted_at IS NULL
        WHERE m.list_id = ? AND m.member_id = ?`,
    )
    .bind(listId, me)
    .first<{ role: string; kind: Kind }>();
}

// ── GET /v1/shared-lists ────────────────────────────────────────────────────

sharedLists.get('/shared-lists', requireAuth, async (c) => {
  const me = c.get('profileId');
  const rows = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.kind, m.role,
            -- A together row is drawn as its one show, so the show travels
            -- with it; an ordinary list reads nothing extra here.
            CASE WHEN l.kind = 'together' THEN (
              SELECT json_object('target_source', i.target_source, 'target_key', i.target_key,
                                 'title', i.title, 'poster', i.poster)
                FROM shared_list_items i WHERE i.list_id = l.id LIMIT 1
            ) END AS show,
            (SELECT COUNT(*) FROM shared_list_members x WHERE x.list_id = l.id) AS members,
            (SELECT COUNT(*) FROM shared_list_items i WHERE i.list_id = l.id) AS items,
            (SELECT MAX(i.created_at) FROM shared_list_items i WHERE i.list_id = l.id) AS last_activity,
            /*
             * ENOUGH ARTWORK TO DRAW THE CARD, and no more.
             *
             * Every shelf that shows a list draws a collage of its first few
             * posters; a shared list sent only a COUNT, so it drew a black
             * rectangle with a name on it -- reported as "I added films and the
             * cover shows nothing, for anybody".
             *
             * Four, because that is what the widest collage draws, joined into
             * one string rather than fetched per list: a poster round trip per
             * row would be a request per list on every visit to the Lists
             * screen, for artwork that is already three columns wide.
             */
            (SELECT GROUP_CONCAT(p, char(10)) FROM (
               SELECT i.poster AS p FROM shared_list_items i
                WHERE i.list_id = l.id AND i.poster IS NOT NULL AND i.poster <> ''
                ORDER BY i.created_at DESC LIMIT 4
             )) AS posters
       FROM shared_list_members m
       JOIN shared_lists l ON l.id = m.list_id
      WHERE m.member_id = ? AND l.deleted_at IS NULL
      ORDER BY COALESCE(last_activity, l.created_at) DESC`,
  )
    .bind(me)
    .all<{
      id: string;
      name: string;
      kind: Kind;
      show: string | null;
      role: string;
      members: number;
      items: number;
      last_activity: string | null;
      posters: string | null;
    }>();

  return c.json({
    lists: (rows.results ?? []).map((r) => ({
      ...r,
      is_owner: r.role === 'owner',
      show: r.show ? (JSON.parse(r.show) as TogetherShow) : null,
      // Split here rather than on the phone: GROUP_CONCAT is a transport
      // detail, and an array is what every caller wants.
      posters: (r.posters ?? '').split('\n').filter(Boolean),
    })),
  });
});

// ── POST /v1/shared-lists ───────────────────────────────────────────────────

sharedLists.post('/shared-lists', requireAuth, async (c) => {
  const me = c.get('profileId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const kind: Kind = b.kind === 'together' ? 'together' : 'list';
  if (b.kind !== undefined && b.kind !== 'list' && b.kind !== 'together') {
    return fail(c, 400, 'invalid_body', "kind is 'list' or 'together'.");
  }

  /*
   * A TOGETHER IS ONE SHOW, AND IT ARRIVES WITH IT, in the same batch as the
   * list — a together with no show is a screen with nothing to draw. Only a
   * `tvdb` show: a film has no episodes, so it has no position to share, and
   * a film "together" is just a shared list.
   */
  let item: TogetherShow | null = null;
  if (kind === 'together') {
    const raw = (b.item ?? {}) as Record<string, unknown>;
    const key = String(raw.target_key ?? '').trim();
    if (raw.target_source !== 'tvdb' || !key) {
      return fail(c, 400, 'target_invalid', "A together needs item.target_source 'tvdb' and a target_key.");
    }
    item = {
      target_source: 'tvdb',
      target_key: key,
      title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : null,
      poster: typeof raw.poster === 'string' ? raw.poster.slice(0, 300) : null,
    };
  }

  // A together is named after its show unless the phone says otherwise; the
  // screens draw the show, so the name is only what the index falls back to.
  let name = String(b.name ?? item?.title ?? '').trim();
  if (kind === 'together') name = name.slice(0, MAX_NAME);
  if (!name || name.length > MAX_NAME) return fail(c, 400, 'invalid_body', 'A name is required.');

  if (kind === 'together') {
    // ALWAYS PLUS, not past a free first: there is no free together (§2.7).
    // Joining one stays free, and so does everything after starting (D11).
    if (!(await hasPlus(c))) {
      return fail(c, 403, 'plus_required', 'Watching together needs OpenTV Plus.');
    }
  } else {
    /*
     * THE CAP IS ON LISTS THIS PERSON STARTED, never on lists they are in. A
     * member of nine lists who has started none is not near any limit. And on
     * ORDINARY lists only: a together already cost Plus, so it must not also
     * use up the free list a lapsed subscriber still has.
     */
    const owned = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM shared_lists WHERE owner_id = ? AND kind = 'list' AND deleted_at IS NULL",
    )
      .bind(me)
      .first<{ n: number }>();

    if ((owned?.n ?? 0) >= FREE_OWNED_LISTS) {
      const owner = await c.env.DB.prepare(
        'SELECT is_plus, plus_until FROM profiles WHERE id = ? AND deleted_at IS NULL',
      )
        .bind(me)
        .first<{ is_plus: number; plus_until: string | null }>();
      if (!owner) return fail(c, 401, 'unauthenticated', 'No such profile.');
      if (!plusOn(owner, new Date().toISOString())) {
        return fail(c, 403, 'plus_required', 'Starting another shared list needs OpenTV Plus.');
      }
    }
  }

  const id = newId('sl');
  const code = newInviteCode();
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO shared_lists (id, owner_id, name, invite_code, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id, me, name, code, now, kind),
    // The owner is a MEMBER with role 'owner', so "who is in this list" is one
    // question with one answer everywhere it is asked.
    c.env.DB.prepare(
      "INSERT INTO shared_list_members (list_id, member_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
    ).bind(id, me, now),
    ...(item
      ? [
          c.env.DB.prepare(
            `INSERT INTO shared_list_items (id, list_id, added_by, target_source, target_key, title, poster, created_at)
             VALUES (?, ?, ?, 'tvdb', ?, ?, ?, ?)`,
          ).bind(newId('si'), id, me, item.target_key, item.title, item.poster, now),
        ]
      : []),
  ]);

  return c.json({ id, invite_code: code });
});

// ── POST /v1/shared-lists/join ──────────────────────────────────────────────

sharedLists.post('/shared-lists/join', requireAuth, async (c) => {
  const me = c.get('profileId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const code = String((body as { invite_code?: unknown })?.invite_code ?? '')
    .trim()
    .toUpperCase();
  if (!code) return fail(c, 400, 'invalid_body', 'An invite code is required.');

  const list = await c.env.DB.prepare(
    'SELECT id, name, kind FROM shared_lists WHERE invite_code = ? AND deleted_at IS NULL',
  )
    .bind(code)
    .first<{ id: string; name: string; kind: Kind }>();
  if (!list) return fail(c, 404, 'not_found', 'No list with that code.');

  const already = await roleOf(c.env.DB, list.id, me);
  // JOINING TWICE IS NOT AN ERROR. Somebody tapping a link they are already in
  // should land in the list, not on a message about it.
  // `kind` rides along so the phone knows a together began without another read.
  if (already) return c.json({ id: list.id, name: list.name, kind: list.kind, joined: false });

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM shared_list_members WHERE list_id = ?')
    .bind(list.id)
    .first<{ n: number }>();
  // A together is a sofa, not a channel (D9): five, so a code pasted somewhere
  // public cannot grow it into an audience.
  const cap = list.kind === 'together' ? MAX_TOGETHER_MEMBERS : MAX_MEMBERS;
  if ((count?.n ?? 0) >= cap) return fail(c, 403, 'list_full', 'This list is full.');

  /*
   * NO PLUS CHECK, AND THERE NEVER WILL BE ONE. Charging to accept an invite
   * makes the paid feature a room with one person in it.
   */
  await c.env.DB.prepare(
    "INSERT INTO shared_list_members (list_id, member_id, role, joined_at) VALUES (?, ?, 'member', ?)",
  )
    .bind(list.id, me, new Date().toISOString())
    .run();

  return c.json({ id: list.id, name: list.name, kind: list.kind, joined: true });
});

// ── GET /v1/shared-lists/:id ────────────────────────────────────────────────

sharedLists.get('/shared-lists/:id', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  const role = await roleOf(c.env.DB, id, me);

  /**
   * A NON-MEMBER MAY NOW READ, BUT NOT TOUCH — because the list is on its
   * members' public profiles, and a shelf whose every tap dead-ends is worse
   * than no shelf.
   *
   * The 404 that used to stand here was right when an invite code was the only
   * way to learn a list existed: refusing by name confirms the name. That is no
   * longer true of a list already printed on a profile a stranger is reading,
   * and keeping the refusal would only mean the profile advertises doors that
   * do not open.
   *
   * So the code changes job rather than losing it. It was READ ACCESS AND WRITE
   * ACCESS AT ONCE; it is now the key to PARTICIPATING — joining, adding,
   * ticking off. Every mutating route below still demands membership, and this
   * one still refuses to hand a non-member the invite code (see `invite_code`),
   * so nobody reads their way into a list or passes the key on.
   *
   * What a non-member does NOT get is the per-member progress: who has watched
   * how much is between the people in the list. A visitor sees what the list is
   * and who is in it, which is what the profile already told them.
   */
  const member = role != null;

  /*
   * `deleted_at IS NULL` is load-bearing NOW in a way it was not before.
   *
   * The membership gate above used to answer for this: deleting a list takes
   * its members with it, so a deleted list had no members and every reader was
   * refused. Opening the route to non-members removed that side effect, and a
   * deleted list became readable by anyone holding its id -- caught by the test
   * that deletes a list and expects everybody to lose it.
   */
  const list = await c.env.DB.prepare(
    'SELECT id, name, kind, invite_code, created_at FROM shared_lists WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first<{ id: string; name: string; kind: Kind; invite_code: string; created_at: string }>();
  if (!list) return fail(c, 404, 'not_found', 'No such list.');

  const members = await c.env.DB.prepare(
    `SELECT p.id, p.handle, p.display_name, p.avatar_key, p.is_plus, p.plus_until, m.role,
            (SELECT COUNT(*) FROM shared_list_watched w
               JOIN shared_list_items i ON i.id = w.item_id
              WHERE w.member_id = p.id AND i.list_id = ?) AS watched
       FROM shared_list_members m JOIN profiles p ON p.id = m.member_id
      WHERE m.list_id = ? AND p.deleted_at IS NULL
      ORDER BY m.joined_at ASC`,
  )
    .bind(id, id)
    .all<{
      id: string;
      handle: string;
      display_name: string | null;
      avatar_key: string | null;
      is_plus: number;
      plus_until: string | null;
      role: string;
      watched: number;
    }>();

  const items = await c.env.DB.prepare(
    `SELECT i.id, i.added_by, i.target_source, i.target_key, i.title, i.poster, i.created_at,
            (SELECT GROUP_CONCAT(w.member_id) FROM shared_list_watched w WHERE w.item_id = i.id) AS watched_by
       FROM shared_list_items i
      WHERE i.list_id = ?
      ORDER BY i.created_at DESC`,
  )
    .bind(id)
    .all<{
      id: string;
      added_by: string | null;
      target_source: string;
      target_key: string;
      title: string | null;
      poster: string | null;
      created_at: string;
      watched_by: string | null;
    }>();

  /*
   * WHERE EACH MEMBER IS — members only, the rule `watched` follows: a visitor
   * learns what the together is and who is in it, never how far anybody got.
   * Read only for a together, so an ordinary list costs nothing new, and only
   * for accounts still standing (a deleted one waits for the purge to cascade).
   */
  const positions = new Map<string, { member_id: string; season: number; episode: number; updated_at: string }[]>();
  if (member && list.kind === 'together') {
    const rows = await c.env.DB.prepare(
      `SELECT s.item_id, s.member_id, s.season, s.episode, s.updated_at
         FROM shared_list_positions s
         JOIN shared_list_items i ON i.id = s.item_id
         JOIN profiles p ON p.id = s.member_id AND p.deleted_at IS NULL
        WHERE i.list_id = ?`,
    )
      .bind(id)
      .all<{ item_id: string; member_id: string; season: number; episode: number; updated_at: string }>();
    for (const { item_id, ...pos } of rows.results ?? []) {
      positions.set(item_id, [...(positions.get(item_id) ?? []), pos]);
    }
  }

  const nowIso = new Date().toISOString();
  return c.json({
    id: list.id,
    name: list.name,
    kind: list.kind,
    is_owner: role === 'owner',
    // THE CODE IS THE OWNER'S ALONE. It lets a stranger in, so a member who
    // was invited cannot hand that power on without the owner knowing.
    invite_code: role === 'owner' ? list.invite_code : null,
    is_member: member,
    created_at: list.created_at,
    members: (members.results ?? []).map((m) => ({
      id: m.id,
      handle: m.handle,
      display_name: m.display_name,
      avatar_key: m.avatar_key,
      is_plus: plusOn(m, nowIso),
      role: m.role,
      is_me: m.id === me,
      // Between the members. A visitor sees who is here, not how far each has got.
      watched: member ? m.watched : 0,
    })),
    items: (items.results ?? []).map((i) => ({
      id: i.id,
      added_by: i.added_by,
      target_source: i.target_source,
      target_key: i.target_key,
      title: i.title,
      poster: i.poster,
      created_at: i.created_at,
      watched_by: i.watched_by ? i.watched_by.split(',') : [],
      positions: positions.get(i.id) ?? [],
    })),
  });
});

// ── POST /v1/shared-lists/:id/items ─────────────────────────────────────────

sharedLists.post('/shared-lists/:id/items', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  // EVERY MEMBER ADDS. A shared list where only the owner may write is a
  // published list with extra steps.
  const membership = await membershipOf(c.env.DB, id, me);
  if (!membership) return fail(c, 404, 'not_found', 'No such list.');
  // A together holds exactly one show, from the batch that created it. Another
  // show is another together.
  if (membership.kind === 'together') return fail(c, 403, 'forbidden', 'A together holds one show.');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const source = String(b.target_source ?? '');
  const key = String(b.target_key ?? '').trim();
  if (!['tvdb', 'tmdb', 'title', 'movie'].includes(source) || !key) {
    return fail(c, 400, 'target_invalid', 'target_source and target_key are required.');
  }

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM shared_list_items WHERE list_id = ?')
    .bind(id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ITEMS) return fail(c, 403, 'list_full', 'This list is full.');

  /*
   * INSERT OR IGNORE against the (list, source, key) unique index. Two people
   * adding the same film within a second of each other is a thing that
   * happens, and it must not be an error for either of them — `added` says
   * which one actually put it there.
   */
  const res = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO shared_list_items (id, list_id, added_by, target_source, target_key, title, poster, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId('si'),
      id,
      me,
      source,
      key,
      typeof b.title === 'string' ? b.title.slice(0, 200) : null,
      typeof b.poster === 'string' ? b.poster.slice(0, 300) : null,
      new Date().toISOString(),
    )
    .run();

  return c.json({ added: (res.meta.changes ?? 0) > 0 });
});

// ── DELETE /v1/shared-lists/:id/items/:itemId ───────────────────────────────

sharedLists.delete('/shared-lists/:id/items/:itemId', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  const membership = await membershipOf(c.env.DB, id, me);
  if (!membership) return fail(c, 404, 'not_found', 'No such list.');
  // Its one show IS the together; ending it is leave or delete, not this.
  if (membership.kind === 'together') return fail(c, 403, 'forbidden', 'A together holds one show.');
  const role = membership.role;

  /*
   * REMOVE YOUR OWN, OR ANYTHING IF YOU OWN THE LIST. A member deleting
   * somebody else's suggestion is the argument this feature does not need;
   * the owner clearing up their own list is housekeeping.
   */
  const item = await c.env.DB.prepare('SELECT added_by FROM shared_list_items WHERE id = ? AND list_id = ?')
    .bind(c.req.param('itemId'), id)
    .first<{ added_by: string | null }>();
  if (!item) return fail(c, 404, 'not_found', 'No such item.');
  if (role !== 'owner' && item.added_by !== me) {
    return fail(c, 403, 'forbidden', 'Only the person who added this, or the list owner, can remove it.');
  }

  await c.env.DB.prepare('DELETE FROM shared_list_items WHERE id = ? AND list_id = ?')
    .bind(c.req.param('itemId'), id)
    .run();
  return c.json({ ok: true });
});

// ── POST/DELETE /v1/shared-lists/:id/items/:itemId/watched ──────────────────

sharedLists.post('/shared-lists/:id/items/:itemId/watched', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  if (!(await roleOf(c.env.DB, id, me))) return fail(c, 404, 'not_found', 'No such list.');

  const item = await c.env.DB.prepare('SELECT id FROM shared_list_items WHERE id = ? AND list_id = ?')
    .bind(c.req.param('itemId'), id)
    .first<{ id: string }>();
  if (!item) return fail(c, 404, 'not_found', 'No such item.');

  // Ticking twice is not an error; it is two taps with one meaning.
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO shared_list_watched (item_id, member_id, marked_at) VALUES (?, ?, ?)',
  )
    .bind(item.id, me, new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

sharedLists.delete('/shared-lists/:id/items/:itemId/watched', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  if (!(await roleOf(c.env.DB, id, me))) return fail(c, 404, 'not_found', 'No such list.');
  // ONLY YOUR OWN TICK. There is no route by which one member unticks another,
  // because "have you seen this" is not a question anybody else may answer.
  await c.env.DB.prepare(
    `DELETE FROM shared_list_watched
      WHERE member_id = ? AND item_id IN (SELECT id FROM shared_list_items WHERE id = ? AND list_id = ?)`,
  )
    .bind(me, c.req.param('itemId'), id)
    .run();
  return c.json({ ok: true });
});

// ── PUT/DELETE /v1/shared-lists/:id/items/:itemId/position ─────────────────

/**
 * The item, when the caller is a member of the together it belongs to — one
 * indexed read of list, membership and item (the 3 rows the budget counts).
 * An ordinary list answers 404 like a list you are not in: a position means
 * nothing on it.
 */
async function togetherItem(db: D1Database, listId: string, itemId: string, me: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM shared_list_items i
         JOIN shared_lists l ON l.id = i.list_id AND l.deleted_at IS NULL AND l.kind = 'together'
         JOIN shared_list_members m ON m.list_id = l.id AND m.member_id = ?
        WHERE i.id = ? AND i.list_id = ?`,
    )
    .bind(me, itemId, listId)
    .first<{ ok: number }>();
  return row != null;
}

sharedLists.put('/shared-lists/:id/items/:itemId/position', requireAuth, async (c) => {
  const me = c.get('profileId');
  const itemId = c.req.param('itemId');
  if (!(await togetherItem(c.env.DB, c.req.param('id'), itemId, me))) {
    return fail(c, 404, 'not_found', 'No such together.');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const { season, episode } = (body ?? {}) as { season?: unknown; episode?: unknown };
  const inRange = (n: unknown): n is number =>
    Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_EPISODE_NUMBER;
  if (!inRange(season) || !inRange(episode)) {
    return fail(c, 400, 'invalid_body', `season and episode are integers 0–${MAX_EPISODE_NUMBER}.`);
  }

  /*
   * OVERWRITTEN, and allowed to go DOWN: un-marking an episode is honest, and
   * a cursor that only climbs would keep claiming something the phone no
   * longer says. Only ever the caller's own row — `member_id` is the session,
   * never the body.
   */
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO shared_list_positions (item_id, member_id, season, episode, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(itemId, me, season, episode, new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

sharedLists.delete('/shared-lists/:id/items/:itemId/position', requireAuth, async (c) => {
  const me = c.get('profileId');
  const itemId = c.req.param('itemId');
  if (!(await togetherItem(c.env.DB, c.req.param('id'), itemId, me))) {
    return fail(c, 404, 'not_found', 'No such together.');
  }
  // Nothing watched any more (or the show left this phone): back to "Not started".
  await c.env.DB.prepare('DELETE FROM shared_list_positions WHERE item_id = ? AND member_id = ?')
    .bind(itemId, me)
    .run();
  return c.json({ ok: true });
});

// ── PATCH /v1/shared-lists/:id ──────────────────────────────────────────────

sharedLists.patch('/shared-lists/:id', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  // OWNER ONLY. Renaming a list under the people in it, or invalidating an
  // invite they are holding, are both the owner's to do.
  if ((await roleOf(c.env.DB, id, me)) !== 'owner') return fail(c, 404, 'not_found', 'No such list.');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if (b.rotate_invite === true) {
    const code = newInviteCode();
    await c.env.DB.prepare('UPDATE shared_lists SET invite_code = ? WHERE id = ?').bind(code, id).run();
    return c.json({ invite_code: code });
  }

  if (typeof b.name === 'string') {
    const name = b.name.trim();
    if (!name || name.length > MAX_NAME) return fail(c, 400, 'invalid_body', 'A name is required.');
    await c.env.DB.prepare('UPDATE shared_lists SET name = ? WHERE id = ?').bind(name, id).run();
    return c.json({ ok: true });
  }

  return fail(c, 400, 'invalid_body', 'Nothing to change.');
});

// ── DELETE /v1/shared-lists/:id ─────────────────────────────────────────────

sharedLists.delete('/shared-lists/:id', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  const role = await roleOf(c.env.DB, id, me);
  if (!role) return fail(c, 404, 'not_found', 'No such list.');

  /*
   * ONE ROUTE, TWO MEANINGS, because from the caller's side both are "this is
   * off my screen now". The owner deletes the list; everybody else leaves it.
   *
   * Soft delete for the owner: the rows stay, so a list is recoverable by hand
   * if somebody deletes one in the wrong moment. Leaving is a hard delete of
   * one membership row — there is nothing to recover and nothing shared about
   * it.
   */
  /*
   * POSITIONS GO IN THE SAME BATCH, because neither path cascades to them: a
   * soft delete removes no rows, and members → positions has no foreign key.
   * A cursor is only kept while the pair it was shared with exists (§0) —
   * the owner ending it drops everybody's, a member leaving drops theirs.
   */
  const dropPositions = (who: string | null) =>
    c.env.DB.prepare(
      `DELETE FROM shared_list_positions
        WHERE item_id IN (SELECT id FROM shared_list_items WHERE list_id = ?)
          AND (? IS NULL OR member_id = ?)`,
    ).bind(id, who, who);
  if (role === 'owner') {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE shared_lists SET deleted_at = ? WHERE id = ?').bind(new Date().toISOString(), id),
      dropPositions(null),
    ]);
  } else {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM shared_list_members WHERE list_id = ? AND member_id = ?').bind(id, me),
      dropPositions(me),
    ]);
  }
  return c.json({ ok: true });
});
