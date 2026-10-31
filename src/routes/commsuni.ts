import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { hasPlus, requireAuth } from '@/middleware';
import { isTranslateTarget, sourceLangOf, validateCommentBody } from '@/pure';
import { runModel } from '@/routes/translate';

/**
 * The CommsUni consent record.
 *
 * WHY THE SERVER HOLDS THIS AND NOT THE PHONE. The phone keeps a copy so it
 * can behave correctly offline, but a copy on a device somebody can reinstall
 * is not a record of anything. The backfill guide requires the decision to
 * exist server-side BEFORE any of that user's comments are sent, because the
 * question it answers is asked later and by somebody else: what did this
 * person agree to, when, and to which words.
 *
 * APPEND-ONLY. Every decision is a new row and nothing is ever updated, so a
 * withdrawal cannot erase the evidence that consent was once given, and
 * consent cannot erase a withdrawal. "Their current answer" is the newest row;
 * everything before it is the history that makes the current answer provable.
 *
 * PENDING IS NOT STORED. A dismissed or unanswered prompt writes nothing. The
 * guide is explicit that it stays `pending` and is not `keep_private` —
 * inactivity is neither permission nor refusal — so "no row" is the honest
 * representation and the app may ask again without having recorded an answer
 * nobody gave.
 */
export const commsuni = new Hono<App>();

/**
 * THE OFF SWITCH, from the dashboard (`POST /v1/admin/commsuni`). One KV flag,
 * read before anything here talks to CommsUni, so turning it off takes effect
 * on the next request with no app update. The app treats the refusal exactly
 * as it treats CommsUni's own rate limit: no board, OpenTV's comments only.
 * Consent stays reachable — it is our own table, not a call to them.
 */
/**
 * A KV key never longer than KV allows (512 bytes). A page-two path carries a
 * ~430-character cursor, and on an EPISODE the key came to 520 — KV threw, the
 * read failed, and "Show more" did nothing (4 Oct; shows squeaked in at 506).
 * Short keys stay readable, so `firstRepliesKey` still matches its page.
 */
export async function kvKey(key: string): Promise<string> {
  if (new TextEncoder().encode(key).length <= 480) return key;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return `${key.slice(0, 12)}#${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export const COMMSUNI_OFF_KEY = 'commsuni:off';
commsuni.use('/commsuni/*', async (c, next) => {
  if (!c.req.path.endsWith('/commsuni/consent') && (await c.env.CACHE.get(COMMSUNI_OFF_KEY))) {
    return fail(c, 503, 'unavailable', 'CommsUni is switched off.');
  }
  await next();
});

type Decision = 'share' | 'keep_private';
type Identity = 'profile' | 'persona';

type Body = {
  decision?: unknown;
  identity?: unknown;
  promptVersion?: unknown;
  coversExisting?: unknown;
};

commsuni.post('/commsuni/consent', requireAuth, async (c) => {
  let body: Body;
  try {
    body = (await c.req.json()) as Body;
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }

  const decision = body.decision;
  if (decision !== 'share' && decision !== 'keep_private') {
    // 'pending' is deliberately not accepted. It is the absence of a record,
    // not a value, and letting a client write it would turn "we never asked"
    // into something indistinguishable from an answer.
    return fail(c, 400, 'invalid_body', 'decision must be share or keep_private.');
  }

  const identity = body.identity === 'persona' ? 'persona' : body.identity === 'profile' ? 'profile' : null;
  if (decision === 'share' && identity === null) {
    // The guide asks the identity question only of somebody who has agreed to
    // share — but it does ask it, and a shared comment has to be attributed
    // one way or the other before it is written.
    return fail(c, 400, 'invalid_body', 'identity is required when sharing.');
  }

  const promptVersion = Number(body.promptVersion);
  if (!Number.isInteger(promptVersion) || promptVersion < 1) {
    return fail(c, 400, 'invalid_body', 'promptVersion must be a positive integer.');
  }

  await c.env.DB.prepare(
    `INSERT INTO commsuni_consent (id, profile_id, decision, identity, prompt_version, covers_existing, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      c.get('profileId'),
      decision,
      // Never stored on a refusal: there is no identity to choose when nothing
      // is being shared, and a value here would imply one was offered.
      decision === 'share' ? identity : null,
      promptVersion,
      body.coversExisting === true ? 1 : 0,
      new Date().toISOString(),
    )
    .run();

  return c.json({ ok: true, decision, identity: decision === 'share' ? identity : null });
});

/**
 * The current answer, and whether history may be sent.
 *
 * `backfillAllowed` is computed here rather than left to a caller to work out,
 * because getting it wrong means publishing somebody's years of writing on the
 * strength of a prompt that never mentioned it. The guide's rule: consent to
 * the shared feature authorises backfill ONLY when the prompt disclosed that
 * existing comments were included.
 */
commsuni.get('/commsuni/consent', requireAuth, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT decision, identity, prompt_version, covers_existing, decided_at
       FROM commsuni_consent WHERE profile_id = ?
      ORDER BY decided_at DESC LIMIT 1`,
  )
    .bind(c.get('profileId'))
    .first<{
      decision: Decision;
      identity: Identity | null;
      prompt_version: number;
      covers_existing: number;
      decided_at: string;
    }>();

  if (!row) return c.json({ decision: 'pending', backfillAllowed: false });

  return c.json({
    decision: row.decision,
    identity: row.identity,
    promptVersion: row.prompt_version,
    coversExisting: row.covers_existing === 1,
    decidedAt: row.decided_at,
    backfillAllowed: row.decision === 'share' && row.covers_existing === 1,
  });
});

/* ── reading the shared board ──────────────────────────────────────────────────
 *
 * PHASE ONE IS READ-ONLY. Comments from the TV Time archive and other CommsUni
 * apps, under an episode, a show or a film. Nothing is written upstream yet.
 *
 * THE KEY NEVER LEAVES THIS WORKER (guide §1): the phone asks us, we ask
 * CommsUni with the key and an opaque per-user actor id (§2), and hand back a
 * trimmed copy. Members only — the guide asks that archive reads not be open to
 * signed-out guests, and our own rule is that somebody who declined the
 * community never contacts this server at all.
 *
 * CACHED FOR BURST PROTECTION, NOT FRESHNESS (§8): a minute for a page (KV's
 * shortest life), three hours for "nothing archived here". The viewer-specific
 * fields are dropped, so one cached page serves everybody on the same thread.
 * A 429 starts a one-minute cooldown in which we stop asking — the key is
 * metered, and a queue of retries is how a quota becomes an outage.
 */

const COMMSUNI_BASE = 'https://api.commsuni.tv/v1';
const COOLDOWN_KEY = 'commsuni:cooldown';

/** HMAC-SHA256(SESSION_SECRET, "commsuni:" + profileId), hex — opaque, stable
 *  per member across devices, and derived here so no device can choose it. */
async function actorId(secret: string, profileId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`commsuni:${profileId}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Upstream = { status: number; body: unknown; duplicate?: boolean };

/** A tally for the bill (migration 0067). Never allowed to cost a comment. */
async function countCall(env: App['Bindings'], kind: 'read' | 'media' | 'write'): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO commsuni_usage (day, kind, calls) VALUES (?, ?, 1)
       ON CONFLICT (day, kind) DO UPDATE SET calls = calls + 1`,
    )
      .bind(new Date().toISOString().slice(0, 10), kind)
      .run();
  } catch {
    // no table yet, or D1 busy: the comment matters more than the count
  }
}

/** One request to CommsUni with an allowlisted set of headers — never the
 *  device's own (§1: no forwarded Origin). */
async function upstream(
  env: App['Bindings'],
  path: string,
  actor: string,
  write?: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; idempotencyKey?: string },
): Promise<Upstream> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.COMMSUNI_API_KEY}`,
    Accept: 'application/json',
    'X-TVTA-Actor-ID': actor,
  };
  if (write?.body !== undefined) headers['Content-Type'] = 'application/json';
  if (write?.idempotencyKey) headers['Idempotency-Key'] = write.idempotencyKey;
  await countCall(env, !write ? 'read' : path === '/media-grants' ? 'media' : 'write');
  const res = await fetch(`${COMMSUNI_BASE}${path}`, {
    method: write?.method ?? 'GET',
    headers,
    body: write?.body !== undefined ? JSON.stringify(write.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  // A second report from the same person is accepted but not queued.
  return { status: res.status, body, duplicate: res.headers.get('Report-Duplicate') === 'true' };
}

type RawSource = { slug?: unknown; displayName?: unknown; shortName?: unknown; accentColor?: unknown; iconUrl?: unknown; status?: unknown };

/** GET /v1/commsuni/sources — the branding table the banner and badges need. */
commsuni.get('/commsuni/sources', requireAuth, async (c) => {
  if (!c.env.COMMSUNI_API_KEY) return fail(c, 503, 'unavailable', 'CommsUni is not configured.');
  const cached = await c.env.CACHE.get('commsuni:sources');
  if (cached) return c.body(cached, 200, { 'Content-Type': 'application/json' });
  if (await c.env.CACHE.get(COOLDOWN_KEY)) return fail(c, 503, 'unavailable', 'Try again later.');

  const up = await upstream(c.env, '/sources', await actorId(c.env.SESSION_SECRET, c.get('profileId')));
  if (up.status === 429) await c.env.CACHE.put(COOLDOWN_KEY, '1', { expirationTtl: 60 });
  const rows = (up.body as { data?: RawSource[] } | null)?.data;
  if (up.status !== 200 || !Array.isArray(rows)) return fail(c, 503, 'unavailable', 'Try again later.');

  const sources = rows
    .filter((r) => typeof r.slug === 'string' && r.status !== 'inactive')
    .map((r) => ({
      slug: String(r.slug),
      displayName: typeof r.displayName === 'string' ? r.displayName : String(r.slug),
      icon: typeof r.iconUrl === 'string' ? r.iconUrl : null,
      accent: typeof r.accentColor === 'string' ? r.accentColor : null,
    }));
  const body = JSON.stringify({ sources });
  // The guide: the catalogue changes when an app joins, not per request.
  await c.env.CACHE.put('commsuni:sources', body, { expirationTtl: 24 * 60 * 60 });
  return c.body(body, 200, { 'Content-Type': 'application/json' });
});

type RawComment = {
  id?: unknown;
  text?: unknown;
  language?: unknown;
  createdAt?: unknown;
  userName?: unknown;
  userAvatar?: unknown;
  userColor?: unknown;
  origin?: { kind?: unknown; slug?: unknown; displayName?: unknown };
  likeCount?: unknown;
  replyCount?: unknown;
  isSpoiler?: unknown;
  deleted?: unknown;
  imageUrl?: unknown;
  attachments?: unknown;
  media?: { kind?: unknown } | null;
};

/** The comment's picture, when it has one: https only, as other apps host it. */
function imageOf(r: RawComment): string | null {
  const first = Array.isArray(r.attachments) ? (r.attachments[0] as { url?: unknown; contentType?: unknown } | undefined) : undefined;
  const url = typeof r.imageUrl === 'string' ? r.imageUrl : typeof first?.url === 'string' ? first.url : null;
  return url && /^https:\/\//.test(url) && url.length <= 1024 ? url : null;
}

/** Only what the app draws. Tombstones are dropped whole (§3: hide them
 *  completely), and viewer state is dropped so the page can be shared. */
export function trimComment(r: RawComment) {
  if (r.deleted === true || typeof r.id !== 'string' || typeof r.text !== 'string') return null;
  const kind = r.origin?.kind === 'tvtime' ? 'tvtime' : 'partner';
  return {
    id: r.id,
    text: r.text,
    language: typeof r.language === 'string' ? r.language : null,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    author: {
      name: typeof r.userName === 'string' ? r.userName : null,
      avatar: typeof r.userAvatar === 'string' ? r.userAvatar : null,
      color: typeof r.userColor === 'string' ? r.userColor : null,
    },
    origin: {
      kind,
      slug: typeof r.origin?.slug === 'string' ? r.origin.slug : kind,
      displayName: typeof r.origin?.displayName === 'string' ? r.origin.displayName : kind === 'tvtime' ? 'TV Time' : '',
    },
    likes: typeof r.likeCount === 'number' ? r.likeCount : 0,
    replyCount: typeof r.replyCount === 'number' ? r.replyCount : 0,
    isSpoiler: r.isSpoiler === true,
    image: imageOf(r),
    /** A private archive picture: fetched through GET /v1/commsuni/media/:id. */
    archiveImage: r.media?.kind === 'archive',
  };
}

/** The upstream path for one of our targets, or null when it cannot be one. */
export function commsuniPath(q: {
  type?: string;
  id?: string;
  season?: string;
  episode?: string;
  sort?: string;
  cursor?: string;
  source?: string;
  language?: string;
}): string | null {
  const id = q.id ?? '';
  if (!/^\d{1,10}$/.test(id)) return null;
  let ref: string;
  if (q.type === 'show' || q.type === 'movie') ref = `${q.type}/tvdb-${id}`;
  else if (q.type === 'episode') {
    if (!/^\d{1,4}$/.test(q.season ?? '') || !/^\d{1,5}$/.test(q.episode ?? '')) return null;
    ref = `episode/tvdb-${id}-s${Number(q.season)}e${Number(q.episode)}`;
  } else return null;
  const sort = q.sort === 'most_recent' || q.sort === 'most_relevant' ? q.sort : 'most_liked';
  const p = new URLSearchParams({ limit: '20', sort });
  if (q.cursor && q.cursor.length <= 512) p.set('cursor', q.cursor);
  // FILTERED ON THEIR SIDE, as the guide asks (§9) — never a page thinned out
  // here. Slugs and one language tag only; anything else is dropped.
  if (q.source && /^[a-z0-9_-]{1,40}(,[a-z0-9_-]{1,40}){0,9}$/.test(q.source)) p.set('source', q.source);
  if (q.language && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(q.language)) p.set('language', q.language);
  // The counts ride on the first page — pre-aggregated per entity, so the
  // tab's number and the language and app chips cost no extra request.
  if (!q.cursor) p.set('include', 'language_counts,source_counts');
  return `/entities/${ref}/comments?${p.toString()}`;
}

/**
 * GET /v1/commsuni/comments?type=episode&id=<show tvdb>&season=1&episode=2
 *                          [&sort=most_liked|most_recent][&cursor=...]
 * type=show|movie take only `id` (a TVDB series or film id).
 */
commsuni.get('/commsuni/comments', requireAuth, async (c) => {
  if (!c.env.COMMSUNI_API_KEY) return fail(c, 503, 'unavailable', 'CommsUni is not configured.');
  const path = commsuniPath({
    type: c.req.query('type'),
    id: c.req.query('id'),
    season: c.req.query('season'),
    episode: c.req.query('episode'),
    sort: c.req.query('sort'),
    cursor: c.req.query('cursor'),
    source: c.req.query('source'),
    language: c.req.query('language'),
  });
  if (!path) return fail(c, 400, 'invalid_body', 'Unknown target.');

  const cacheKey = await kvKey(`commsuni:c:${path}`);
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) return c.body(cached, 200, { 'Content-Type': 'application/json' });
  if (await c.env.CACHE.get(COOLDOWN_KEY)) return fail(c, 503, 'unavailable', 'Try again later.');

  let up: Upstream;
  try {
    up = await upstream(c.env, path, await actorId(c.env.SESSION_SECRET, c.get('profileId')));
  } catch {
    return fail(c, 503, 'unavailable', 'Try again later.');
  }

  if (up.status === 404) {
    // Never archived. Not an error — the same empty state as a quiet thread —
    // and cached for hours, as the guide asks, since the first native comment
    // is the only thing that would change it.
    const body = JSON.stringify({ comments: [], nextCursor: null, archived: false });
    await c.env.CACHE.put(cacheKey, body, { expirationTtl: 3 * 60 * 60 });
    return c.body(body, 200, { 'Content-Type': 'application/json' });
  }
  if (up.status === 429) await c.env.CACHE.put(COOLDOWN_KEY, '1', { expirationTtl: 60 });
  const data = (up.body as { data?: { comments?: RawComment[]; nextCursor?: unknown; languageCounts?: unknown; sourceCounts?: unknown } } | null)?.data;
  if (up.status !== 200 || !data || !Array.isArray(data.comments)) {
    if (up.status !== 429) console.log(`[commsuni] ${up.status} ${JSON.stringify((up.body as { error?: unknown } | null)?.error ?? null)}`);
    return fail(c, 503, 'unavailable', 'Try again later.');
  }

  const body = JSON.stringify({
    comments: data.comments.map(trimComment).filter((x) => x !== null),
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
    archived: true,
    // First page only, under the same source filter.
    languageCounts: Array.isArray(data.languageCounts)
      ? (data.languageCounts as { language?: unknown; count?: unknown }[])
          .filter((l) => typeof l?.language === 'string' && typeof l?.count === 'number')
          .map((l) => ({ language: l.language as string, count: l.count as number }))
      : null,
    // Per app (facc, 6 Oct): follows the language filter, ignores the source one.
    sourceCounts: Array.isArray(data.sourceCounts)
      ? (data.sourceCounts as { source?: unknown; count?: unknown }[])
          .filter((l) => typeof l?.source === 'string' && typeof l?.count === 'number')
          .map((l) => ({ source: l.source as string, count: l.count as number }))
      : null,
  });
  await c.env.CACHE.put(cacheKey, body, { expirationTtl: 60 });
  return c.body(body, 200, { 'Content-Type': 'application/json' });
});

/**
 * GET /v1/commsuni/replies?id=<comment uuid>[&cursor=...]
 *
 * One thread's replies, fetched only when somebody taps to open it (the guide:
 * "fetch replies lazily when the user expands a thread"). Same trim, same
 * one-minute cache and 429 cooldown as a comment page.
 */
commsuni.get('/commsuni/replies', requireAuth, async (c) => {
  if (!c.env.COMMSUNI_API_KEY) return fail(c, 503, 'unavailable', 'CommsUni is not configured.');
  const id = c.req.query('id') ?? '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return fail(c, 400, 'invalid_body', 'Unknown comment.');
  const p = new URLSearchParams({ limit: '50', sort: 'most_recent' });
  // A reply's own replies (the guide's second level): same thread, `parent=`.
  const branch = c.req.query('parent');
  if (branch && UUID_RE.test(branch)) p.set('parent', branch);
  const cursor = c.req.query('cursor');
  if (cursor && cursor.length <= 512) p.set('cursor', cursor);
  const path = `/comments/${id}/replies?${p.toString()}`;

  const cacheKey = await kvKey(`commsuni:r:${path}`);
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) return c.body(cached, 200, { 'Content-Type': 'application/json' });
  if (await c.env.CACHE.get(COOLDOWN_KEY)) return fail(c, 503, 'unavailable', 'Try again later.');

  let up: Upstream;
  try {
    up = await upstream(c.env, path, await actorId(c.env.SESSION_SECRET, c.get('profileId')));
  } catch {
    return fail(c, 503, 'unavailable', 'Try again later.');
  }
  if (up.status === 429) await c.env.CACHE.put(COOLDOWN_KEY, '1', { expirationTtl: 60 });
  const data = (up.body as { data?: { replies?: RawComment[]; nextCursor?: unknown } } | null)?.data;
  if (up.status !== 200 || !data || !Array.isArray(data.replies)) {
    if (up.status !== 429) console.log(`[commsuni] replies ${up.status}`);
    return fail(c, 503, 'unavailable', 'Try again later.');
  }
  const body = JSON.stringify({
    replies: data.replies.map(trimComment).filter((x) => x !== null),
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
  });
  await c.env.CACHE.put(cacheKey, body, { expirationTtl: 60 });
  return c.body(body, 200, { 'Content-Type': 'application/json' });
});

/** Where a comment of ours lives on CommsUni, or null when it cannot live there. */
export function commsuniEntityRef(row: { target_source: string; target_key: string; season: number | null; episode: number | null }, tvdbMovie: number | null): string | null {
  if (row.target_source === 'tvdb' && /^\d+$/.test(row.target_key)) {
    if (row.season != null && row.episode != null) return `episode/tvdb-${row.target_key}-s${row.season}e${row.episode}`;
    if (row.season == null && row.episode == null) return `show/tvdb-${row.target_key}`;
    return null;
  }
  return tvdbMovie != null && tvdbMovie > 0 ? `movie/tvdb-${tvdbMovie}` : null;
}

/**
 * POST /v1/commsuni/share { comment_id, tvdb_movie? }
 *
 * SHARES A COMMENT THAT ALREADY EXISTS HERE, by id — never text the app sends
 * along. So everything that reaches CommsUni has already passed through our own
 * posting rules (length, rate limit) and is still live: a deleted or hidden
 * comment, someone else's, or a reply cannot be shared. That is our pre-send
 * moderation (§10): the same bar as a comment that stays on OpenTV.
 *
 * Words only. Our pictures wait for a person to approve them, so none is sent.
 * Only for an author whose LATEST consent is `share`; their identity choice
 * decides whether their OpenTV name goes with it or CommsUni's generated one.
 */
commsuni.post('/commsuni/share', requireAuth, async (c) => {
  if (!c.env.COMMSUNI_API_KEY) return fail(c, 503, 'unavailable', 'CommsUni is not configured.');
  let b: { comment_id?: unknown; tvdb_movie?: unknown };
  try {
    b = (await c.req.json()) as typeof b;
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const me = c.get('profileId');
  const id = typeof b.comment_id === 'string' ? b.comment_id : '';
  const consent = await c.env.DB.prepare(
    'SELECT decision, identity FROM commsuni_consent WHERE profile_id = ? ORDER BY decided_at DESC LIMIT 1',
  )
    .bind(me)
    .first<{ decision: string; identity: string | null }>();
  if (consent?.decision !== 'share') return fail(c, 403, 'forbidden', 'Sharing is not on.');

  const row = await c.env.DB.prepare(
    `SELECT c.target_source, c.target_key, c.season, c.episode, c.body, c.is_spoiler, c.lang, p.handle, p.display_name, p.avatar_key
       FROM comments c JOIN profiles p ON p.id = c.author_id
      WHERE c.id = ? AND c.author_id = ? AND c.parent_id IS NULL AND c.deleted_at IS NULL AND c.hidden_at IS NULL AND c.imported_at IS NULL`,
  )
    .bind(id, me)
    .first<{ target_source: string; target_key: string; season: number | null; episode: number | null; body: string; is_spoiler: number; lang: string | null; handle: string; display_name: string | null; avatar_key: string | null }>();
  if (!row) return fail(c, 404, 'not_found', 'No such comment.');
  if (!row.body.trim()) return fail(c, 400, 'invalid_body', 'Only comments with words are shared.');
  const ref = commsuniEntityRef(row, typeof b.tvdb_movie === 'number' ? b.tvdb_movie : null);
  if (!ref) return fail(c, 400, 'invalid_body', 'This title is not on CommsUni.');
  const prior = await c.env.DB.prepare('SELECT commsuni_id FROM comments WHERE id = ?').bind(id).first<{ commsuni_id: string | null }>();
  if (prior?.commsuni_id) return c.json({ ok: true, already: true, commsuni_id: prior.commsuni_id });
  if (await c.env.CACHE.get(COOLDOWN_KEY)) return fail(c, 503, 'unavailable', 'Try again later.');

  const actor = await actorId(c.env.SESSION_SECRET, me);
  try {
    await sendOverlay(c.env, me, actor, consent.identity, row, new URL(c.req.url).origin);
    const up = await upstream(c.env, `/entities/${ref}/comments`, actor, {
      method: 'POST',
      idempotencyKey: id,
      body: { text: row.body, language: row.lang ?? undefined, isSpoiler: row.is_spoiler === 1 },
    });
    if (up.status === 429) await c.env.CACHE.put(COOLDOWN_KEY, '1', { expirationTtl: 60 });
    const theirs = (up.body as { data?: { comment?: { id?: unknown } } } | null)?.data?.comment?.id;
    if (up.status !== 201 && up.status !== 200) {
      console.log(`[commsuni] share ${up.status} ${JSON.stringify((up.body as { error?: unknown } | null)?.error ?? null)}`);
      return fail(c, 503, 'unavailable', 'Try again later.');
    }
    if (typeof theirs === 'string') await c.env.DB.prepare('UPDATE comments SET commsuni_id = ? WHERE id = ?').bind(theirs, id).run();
    return c.json({ ok: true, commsuni_id: typeof theirs === 'string' ? theirs : null });
  } catch {
    return fail(c, 503, 'unavailable', 'Try again later.');
  }
});

/**
 * The profile overlay before a write (§11): their OpenTV name and picture, or
 * nothing at all and CommsUni's generated persona. The name and picture are IN
 * the key: a renamed handle, a new display name or a new photo is a new
 * overlay, sent on the next write rather than after the week-long stamp.
 */
async function sendOverlay(
  env: App['Bindings'],
  me: string,
  actor: string,
  identity: string | null,
  who: { handle: string; display_name: string | null; avatar_key: string | null },
  origin: string,
): Promise<void> {
  const profileKey = `commsuni:profile:${me}:${identity}:${who.display_name || who.handle}:${who.avatar_key ?? ''}`;
  if (await env.CACHE.get(profileKey)) return;
  const avatarUrl = who.avatar_key ? `${origin}/v1/${who.avatar_key}` : null;
  const done =
    identity === 'profile'
      ? await upstream(env, '/authors/me/profile', actor, { method: 'PUT', body: { displayName: (who.display_name || who.handle).slice(0, 64), avatarUrl } })
      : await upstream(env, '/authors/me/profile', actor, { method: 'DELETE' });
  if (done.status < 300) await env.CACHE.put(profileKey, '1', { expirationTtl: 7 * 24 * 60 * 60 });
}

/** The cached first page of a comment's replies (GET /commsuni/replies), so the writer sees their own at once. */
const firstRepliesKey = (parent: string) =>
  `commsuni:r:/comments/${parent}/replies?${new URLSearchParams({ limit: '50', sort: 'most_recent' }).toString()}`;

/** Replies a person may send to CommsUni in an hour: the same cap as our own comments. */
const REPLIES_PER_HOUR = 30;

/** GIPHY's own media addresses, the only GIFs the reply composer offers. */
const GIPHY_GIF = /^https:\/\/(media[0-9]*|i)\.giphy\.com\/[A-Za-z0-9_./?=&%-]{1,400}$/;

/**
 * POST /v1/commsuni/reply { parent, text, client_id }
 *
 * A reply to a comment on the shared board. Unlike a top-level share there is
 * no OpenTV comment to send by id — the parent lives on CommsUni — so this is
 * where our pre-send rules (§10) run instead: the same body rules as a comment
 * here (words, 2,000 characters), an hourly cap per person, and the latest
 * consent must be `share`. `client_id` is the idempotency key, so a retried
 * tap cannot post twice. Nothing is stored here: the reply is CommsUni's, and
 * its id goes back to the phone, which is what deletes it again.
 */
commsuni.post('/commsuni/reply', requireAuth, async (c) => {
  if (!c.env.COMMSUNI_API_KEY) return fail(c, 503, 'unavailable', 'CommsUni is not configured.');
  let b: { parent?: unknown; root?: unknown; text?: unknown; client_id?: unknown; spoiler?: unknown; gif?: unknown };
  try {
    b = (await c.req.json()) as typeof b;
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const parent = typeof b.parent === 'string' ? b.parent : '';
  const clientId = typeof b.client_id === 'string' ? b.client_id : '';
  if (!UUID_RE.test(parent) || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) return fail(c, 400, 'invalid_body', 'parent and client_id are required.');
  // A GIPHY GIF, by its own address — CommsUni stores links, not files, and
  // only from hosts allowlisted for our source (§11).
  const gif = typeof b.gif === 'string' && GIPHY_GIF.test(b.gif) ? b.gif : null;
  const text = validateCommentBody(b.text);
  const words = text.ok ? text.body : '';
  if (!text.ok && (text.reason === 'too_long' || !gif)) {
    return text.reason === 'too_long'
      ? fail(c, 400, 'too_large', 'A comment is at most 2,000 characters.')
      : fail(c, 400, 'invalid_body', 'text is required.');
  }
  const isSpoiler = b.spoiler === true;
  // A GIF is Plus, as a picture on a comment is everywhere else — checked here
  // because a client can claim anything.
  if (gif && !(await hasPlus(c))) return fail(c, 403, 'plus_required', 'A GIF in a reply needs OpenTV Plus.');
  const me = c.get('profileId');
  const consent = await c.env.DB.prepare(
    'SELECT decision, identity FROM commsuni_consent WHERE profile_id = ? ORDER BY decided_at DESC LIMIT 1',
  )
    .bind(me)
    .first<{ decision: string; identity: string | null }>();
  if (consent?.decision !== 'share') return fail(c, 403, 'forbidden', 'Sharing is not on.');
  const who = await c.env.DB.prepare('SELECT handle, display_name, avatar_key FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first<{ handle: string; display_name: string | null; avatar_key: string | null }>();
  if (!who) return fail(c, 401, 'unauthenticated', 'No such profile.');

  const capKey = `commsuni:replies:${me}:${new Date().toISOString().slice(0, 13)}`;
  const sent = Number((await c.env.CACHE.get(capKey)) ?? 0);
  if (sent >= REPLIES_PER_HOUR) return fail(c, 429, 'rate_limited', 'Too many comments in the last hour.');
  if (await c.env.CACHE.get(COOLDOWN_KEY)) return fail(c, 503, 'unavailable', 'Try again later.');

  const actor = await actorId(c.env.SESSION_SECRET, me);
  try {
    await sendOverlay(c.env, me, actor, consent.identity, who, new URL(c.req.url).origin);
    const write = (withGif: boolean, key: string) =>
      upstream(c.env, `/comments/${parent}/replies`, actor, {
        method: 'POST',
        idempotencyKey: key,
        body: {
          ...(words ? { text: words } : {}),
          isSpoiler,
          ...(withGif && gif ? { attachments: [{ url: gif, contentType: 'image/gif', provider: 'giphy' }] } : {}),
        },
      });
    let up = await write(gif != null, clientId);
    // GIPHY NOT YET ALLOWLISTED for our source: the words still go, without
    // the picture, under their own key (a changed body on the same key is a
    // 409). A GIF-only reply has nothing left to send and says so.
    if (up.status === 400 && gif) {
      console.log(`[commsuni] reply gif refused ${JSON.stringify((up.body as { error?: unknown } | null)?.error ?? null)}`);
      if (!words) return fail(c, 422, 'unsupported_type', 'CommsUni does not take this GIF yet.');
      up = await write(false, `${clientId}-t`);
    }
    if (up.status === 429) await c.env.CACHE.put(COOLDOWN_KEY, '1', { expirationTtl: 60 });
    if (up.status === 404) return fail(c, 404, 'not_found', 'No such comment.');
    if (up.status !== 201 && up.status !== 200) {
      console.log(`[commsuni] reply ${up.status} ${JSON.stringify((up.body as { error?: unknown } | null)?.error ?? null)}`);
      return fail(c, 503, 'unavailable', 'Try again later.');
    }
    await c.env.CACHE.put(capKey, String(sent + 1), { expirationTtl: 3600 });
    // THE SPOILER FLAG, MADE SURE OF. A reply sent marked came back unmarked
    // (5 Oct); if theirs did not keep it, set it — §11 allows PATCH isSpoiler
    // on your own comment.
    const made = (up.body as { data?: { comment?: { id?: unknown; isSpoiler?: unknown } } } | null)?.data?.comment;
    if (isSpoiler && typeof made?.id === 'string' && made.isSpoiler !== true) {
      try {
        await upstream(c.env, `/comments/${made.id}`, actor, { method: 'PATCH', body: { isSpoiler: true } });
      } catch {
        // The words are up; a missing flag is not worth failing the reply.
      }
    }
    await c.env.CACHE.delete(firstRepliesKey(parent));
    // Answering a reply: the root's thread and that branch both changed.
    const root = typeof b.root === 'string' && UUID_RE.test(b.root) ? b.root : null;
    if (root) {
      await c.env.CACHE.delete(firstRepliesKey(root));
      await c.env.CACHE.delete(
        await kvKey(`commsuni:r:/comments/${root}/replies?${new URLSearchParams({ limit: '50', sort: 'most_recent', parent }).toString()}`),
      );
    }
    const theirs = (up.body as { data?: { comment?: { id?: unknown } } } | null)?.data?.comment?.id;
    return c.json({ ok: true, commsuni_id: typeof theirs === 'string' ? theirs : null });
  } catch {
    return fail(c, 503, 'unavailable', 'Try again later.');
  }
});

/** DELETE /v1/commsuni/reply/:id — take one's own reply back. CommsUni checks it is theirs. */
commsuni.delete('/commsuni/reply/:id', requireAuth, async (c) => {
  if (!c.env.COMMSUNI_API_KEY) return fail(c, 503, 'unavailable', 'CommsUni is not configured.');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return fail(c, 400, 'invalid_body', 'Unknown comment.');
  try {
    const up = await upstream(c.env, `/comments/${id}`, await actorId(c.env.SESSION_SECRET, c.get('profileId')), { method: 'DELETE' });
    if (up.status === 204 || up.status === 404) {
      const parent = c.req.query('parent') ?? '';
      if (UUID_RE.test(parent)) await c.env.CACHE.delete(firstRepliesKey(parent));
      return c.json({ ok: true });
    }
    return fail(c, up.status === 403 ? 403 : 503, up.status === 403 ? 'forbidden' : 'unavailable', 'Could not delete.');
  } catch {
    return fail(c, 503, 'unavailable', 'Try again later.');
  }
});

/**
 * Take a shared comment back off CommsUni when it is deleted here. Called from
 * the comment DELETE route; never throws, because the deletion on OpenTV has
 * already happened and is what the person asked for.
 */
export async function unshareComment(env: App['Bindings'], profileId: string, commentId: string): Promise<void> {
  try {
    const theirs = (await env.DB.prepare('SELECT commsuni_id FROM comments WHERE id = ? AND author_id = ?').bind(commentId, profileId).first<{ commsuni_id: string | null }>())?.commsuni_id;
    if (!theirs || !env.COMMSUNI_API_KEY) return;
    const up = await upstream(env, `/comments/${encodeURIComponent(theirs)}`, await actorId(env.SESSION_SECRET, profileId), { method: 'DELETE' });
    if (up.status === 204 || up.status === 404) await env.DB.prepare('UPDATE comments SET commsuni_id = NULL WHERE id = ?').bind(commentId).run();
  } catch {
    // Left for a later cleanup pass; the comment is already gone here.
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /v1/commsuni/media/:id — the archive picture of one CommsUni comment,
 * by its id. That is a board comment's id, or the ORIGINAL TV Time comment id
 * an import kept (§4: "you do not need to read comments to read media").
 *
 * THE BYTES ARE CACHED, NEVER THE URL. CommsUni signs a five-minute URL per
 * image and charges for each; the guide forbids storing one. So the first
 * reader's request asks for a grant, downloads the picture, and puts the
 * picture itself in this Worker's edge cache under our own URL for a month —
 * every later reader costs CommsUni nothing. "No picture" is remembered for
 * six hours, so a missing one is not asked for again on every scroll.
 */
commsuni.get('/commsuni/media/:id', requireAuth, async (c) => {
  if (!c.env.COMMSUNI_API_KEY) return fail(c, 503, 'unavailable', 'CommsUni is not configured.');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return fail(c, 400, 'invalid_body', 'Unknown comment.');

  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`https://media-cache.opentv.internal/commsuni/${id}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const missingKey = `commsuni:media-missing:${id}`;
  if (await c.env.CACHE.get(missingKey)) return fail(c, 404, 'not_found', 'No picture.');
  if (await c.env.CACHE.get(COOLDOWN_KEY)) return fail(c, 503, 'unavailable', 'Try again later.');

  try {
    const up = await upstream(c.env, '/media-grants', await actorId(c.env.SESSION_SECRET, c.get('profileId')), {
      method: 'POST',
      body: { commentIds: [id] },
    });
    if (up.status === 429) await c.env.CACHE.put(COOLDOWN_KEY, '1', { expirationTtl: 60 });
    const grant = (up.body as { data?: { grants?: { status?: string; url?: unknown; contentType?: unknown }[] } } | null)?.data?.grants?.[0];
    if (up.status !== 200 || grant?.status !== 'granted' || typeof grant.url !== 'string' || !grant.url.startsWith('https://')) {
      if (up.status === 200) await c.env.CACHE.put(missingKey, '1', { expirationTtl: 6 * 60 * 60 });
      return fail(c, 404, 'not_found', 'No picture.');
    }
    // No Authorization on the delivery host (§4b): it is a different host and
    // the signed URL is the only credential it needs.
    const img = await fetch(grant.url);
    if (!img.ok || !img.body) return fail(c, 503, 'unavailable', 'Try again later.');
    const res = new Response(img.body, {
      headers: {
        'Content-Type': typeof grant.contentType === 'string' ? grant.contentType : (img.headers.get('Content-Type') ?? 'image/jpeg'),
        'Cache-Control': 'public, max-age=2592000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch {
    return fail(c, 503, 'unavailable', 'Try again later.');
  }
});


/**
 * POST /v1/commsuni/translate { text, language, lang }
 *
 * The archive's comments are not stored here, so — unlike OpenTV's own
 * translate route — the TEXT comes from the app, which got it from us a moment
 * ago. The cache is therefore keyed by a hash OF THE TEXT, never a comment id:
 * a client sending made-up words for somebody else's comment can only ever
 * cache a translation of its own made-up words. Capped per member per hour so
 * the route is not a free translation service.
 */
const TRANSLATIONS_PER_HOUR = 200;
commsuni.post('/commsuni/translate', requireAuth, async (c) => {
  if (!c.env.AI) return fail(c, 404, 'unavailable', 'Translation is not enabled.');
  const body = (await c.req.json().catch(() => null)) as { text?: unknown; language?: unknown; lang?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const lang = body?.lang;
  if (!text || text.length > 5000 || !isTranslateTarget(lang)) return fail(c, 400, 'invalid_body', 'text and lang are required.');

  const source = sourceLangOf(typeof body?.language === 'string' ? body.language : null, text);
  if (source === lang) return c.json({ text, source_lang: source, same: true });

  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const key = `commsuni:tr:${lang}:${hash}`;
  const hit = await c.env.CACHE.get(key);
  if (hit) return c.json({ text: hit, source_lang: source });

  const capKey = `commsuni:tr-cap:${c.get('profileId')}:${new Date().toISOString().slice(0, 13)}`;
  const used = Number((await c.env.CACHE.get(capKey)) ?? 0);
  if (used >= TRANSLATIONS_PER_HOUR) return fail(c, 429, 'rate_limited', 'Too many translations — try again later.');

  const out = await runModel(c.env.AI, text, source, lang);
  if (out == null) return fail(c, 503, 'translate_failed', 'Could not translate right now.');
  await c.env.CACHE.put(capKey, String(used + 1), { expirationTtl: 3600 });
  await c.env.CACHE.put(key, out, { expirationTtl: 30 * 24 * 60 * 60 });
  return c.json({ text: out, source_lang: source });
});

/** Reasons CommsUni accepts. The `mine_*` two are for TV Time archive rows only. */
const REPORT_REASONS = new Set(['spam', 'abuse', 'spoiler', 'sexual', 'illegal', 'other', 'mine_hide', 'mine_claim']);
const REPORTS_PER_HOUR = 20;

/**
 * POST /v1/commsuni/report { id, reason, detail?, archived, client_id }
 *
 * Moderation on the shared board (§10): every comment from another app can be
 * reported, and an archived TV Time comment can also be flagged "this is
 * mine" — hide it, or claim it later. `mine_*` is refused unless the app says
 * the row is from the archive, as the guide forbids it on native comments.
 * No sharing consent needed: a report publishes nothing of the reporter's.
 */
commsuni.post('/commsuni/report', requireAuth, async (c) => {
  if (!c.env.COMMSUNI_API_KEY) return fail(c, 503, 'unavailable', 'CommsUni is not configured.');
  const b = (await c.req.json().catch(() => null)) as { id?: unknown; reason?: unknown; detail?: unknown; archived?: unknown; client_id?: unknown } | null;
  const id = typeof b?.id === 'string' ? b.id : '';
  const reason = typeof b?.reason === 'string' ? b.reason : '';
  const clientId = typeof b?.client_id === 'string' ? b.client_id : '';
  if (!UUID_RE.test(id) || !REPORT_REASONS.has(reason) || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) {
    return fail(c, 400, 'invalid_body', 'id, reason and client_id are required.');
  }
  if (reason.startsWith('mine_') && b?.archived !== true) {
    return fail(c, 400, 'invalid_body', 'Only an archived TV Time comment can be claimed.');
  }
  const me = c.get('profileId');
  const capKey = `commsuni:reports:${me}:${new Date().toISOString().slice(0, 13)}`;
  const sent = Number((await c.env.CACHE.get(capKey)) ?? 0);
  if (sent >= REPORTS_PER_HOUR) return fail(c, 429, 'rate_limited', 'Too many reports in the last hour.');
  const detail = typeof b?.detail === 'string' && b.detail.trim() ? b.detail.trim().slice(0, 1000) : undefined;
  try {
    const up = await upstream(c.env, `/comments/${id}/reports`, await actorId(c.env.SESSION_SECRET, me), {
      method: 'POST',
      idempotencyKey: clientId,
      body: { reason, ...(detail ? { detail } : {}) },
    });
    if (up.status === 404) return fail(c, 404, 'not_found', 'No such comment.');
    if (up.status !== 202 && up.status !== 200) {
      console.log(`[commsuni] report ${up.status}`);
      return fail(c, 503, 'unavailable', 'Try again later.');
    }
    await c.env.CACHE.put(capKey, String(sent + 1), { expirationTtl: 3600 });
    return c.json({ ok: true, duplicate: up.duplicate === true });
  } catch {
    return fail(c, 503, 'unavailable', 'Try again later.');
  }
});

/**
 * A NEW NAME OR PICTURE REACHES THE OTHER APPS AT ONCE (facc, 5 Oct). The
 * overlay used to go up only before a write, so a rename sat unseen on every
 * comment already shared until the next one. Called after a handle, display
 * name or avatar change; does nothing for somebody not sharing.
 */
export async function refreshCommsuniProfile(env: App['Bindings'], me: string, origin: string): Promise<void> {
  if (!env.COMMSUNI_API_KEY) return;
  const consent = await env.DB.prepare('SELECT decision, identity FROM commsuni_consent WHERE profile_id = ? ORDER BY decided_at DESC LIMIT 1')
    .bind(me)
    .first<{ decision: string; identity: string | null }>();
  if (consent?.decision !== 'share') return;
  const who = await env.DB.prepare('SELECT handle, display_name, avatar_key FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first<{ handle: string; display_name: string | null; avatar_key: string | null }>();
  if (!who) return;
  await sendOverlay(env, me, await actorId(env.SESSION_SECRET, me), consent.identity, who, origin);
}
