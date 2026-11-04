import { insufficientScope, type OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import type { Env } from '@/env';
import { plusFor } from '@/middleware';
import { bestBackupKey } from '@/routes/backup';
import { RETAIN_DAYS } from '@/routes/sync';
import {
  applyOps,
  FEELINGS,
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
  type Library,
  type Plan,
  type RelayOp,
} from '@/mcp/library';

/**
 * OpenTV as an MCP server: a member's own history, answerable in Claude and
 * ChatGPT (2.3.0, Plus).
 *
 * STATELESS, NOT `McpAgent`. The brief said McpAgent; the installed `agents`
 * release deprecates it (built on MCP SDK v1) in favour of `createMcpHandler`
 * with SDK v2, which needs no Durable Object, no session and no migration. Read
 * tools need none of those, so there is nothing for a Durable Object to hold.
 *
 * THE DATA IS THE BACKUP, READ WHEN ASKED. The member's own ZIP in R2 — the
 * same object a restore would get (`bestBackupKey`) — parsed in memory on the
 * first question and kept in this isolate while its etag holds. Nothing derived
 * is written anywhere: no table, no per-user database. Turning Backup off or
 * deleting it makes every tool say so on the next question.
 *
 * Every call re-checks Plus. A grant outlives a subscription (refresh tokens
 * live 90 days), and the answer to a lapsed member is a sentence, not a 401
 * that makes Claude ask them to sign in again.
 *
 * WRITES ARE RELAY OPS, NEVER ROWS. Mark watched, rate, watchlist and a
 * feeling go into `sync_ops` exactly as a second phone's would, from a device
 * called "assistant", and the member's phones apply them the next time OpenTV
 * opens. The server still keeps no library: the op is the same short-lived
 * message Sync already carries, pruned at 90 days. Only kinds the shipped
 * phones parse (`mobile/src/sync-ops.ts`) are ever written.
 *
 * Three gates on a write, each a sentence rather than an error code: the
 * `mcp:write` scope (a connection approved when the page said "it cannot change
 * anything" keeps meaning that until it is made again), Plus, and Sync — a
 * member with no relay has no phone listening, and an op nobody pulls is a
 * change that silently never happens.
 *
 * THE ASSISTANT IS NOT A DEVICE ON THE LIST. Its ops are inserted directly,
 * never through `POST /v1/sync`, so it is never registered in `devices`: it
 * cannot take one of the five places or be refused for want of one, and "Your
 * devices" stays a list of phones. It never pulls, so it needs no cursor.
 */

// ── the parsed-library cache ─────────────────────────────────────────────────

type Cached = { tag: string; asOf: string | null; lib: Library };
const cache = new Map<string, Cached>();
/** ponytail: a few libraries per isolate (~1 MB ZIP, a few MB parsed). Least
 *  recently used goes first; an isolate is recycled long before this matters. */
const CACHE_MAX = 8;

export type Loaded = { lib: Library; asOf: string | null };

/** The member's library, or null when there is no backup to read. */
export async function loadLibrary(env: Env, profileId: string): Promise<Loaded | null> {
  const bucket = env.BACKUPS;
  if (!bucket) return null;
  const key = await bestBackupKey(bucket, profileId);
  if (!key) return null;
  const head = await bucket.head(key);
  if (!head) return null;
  const asOf = head.uploaded?.toISOString?.() ?? null;
  const tag = `${key}|${head.etag ?? ''}|${asOf ?? ''}`;

  const hit = cache.get(profileId);
  if (hit && hit.tag === tag) {
    cache.delete(profileId);
    cache.set(profileId, hit);
    return hit;
  }
  const object = await bucket.get(key);
  if (!object) return null;
  const lib = parseLibrary(new Uint8Array(await new Response(object.body).arrayBuffer()));
  cache.set(profileId, { tag, asOf, lib });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return { lib, asOf };
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

// No upgrade prompt here: the ChatGPT directory forbids promoting a
// subscription inside the conversation. Say what is true and stop.
const NO_PLUS = 'This OpenTV account does not include the Claude and ChatGPT connection right now, so this cannot be done.';

/** `sync_ops.created_at` is SQLite's `YYYY-MM-DD HH:MM:SS`, UTC; R2's upload time is ISO. */
const sqlTime = (iso: string) => iso.replace('T', ' ').slice(0, 19);

/**
 * The relay ops written AFTER this backup was uploaded: what other devices, and
 * this assistant, changed since. Arrival time, not the device clock, decides
 * "after" — a phone's clock cannot be compared with R2's.
 *
 * ponytail: an op pushed a moment before the upload, from a device whose
 * change the uploading phone had not pulled yet, is in neither. It shows after
 * the next backup.
 */
export async function opsSince(env: Env, profileId: string, asOf: string | null): Promise<RelayOp[]> {
  if (!asOf) return [];
  const { results } = await env.DB.prepare(
    'SELECT ts, kind, payload FROM sync_ops WHERE profile_id = ? AND created_at > ? ORDER BY ts, seq LIMIT 5000',
  )
    .bind(profileId, sqlTime(asOf))
    .all<RelayOp>();
  return results ?? [];
}

/** The library as of now: the backup, plus what the relay has heard since. */
async function freshLibrary(env: Env, profileId: string): Promise<{ loaded: (Loaded & { since: number }) | null; error?: CallToolResult }> {
  let loaded: Loaded | null;
  try {
    loaded = await loadLibrary(env, profileId);
  } catch (e) {
    console.error('[mcp] backup unreadable', e instanceof Error ? e.message : String(e));
    return { loaded: null, error: text('The OpenTV backup could not be read. Open OpenTV so it backs up again, then ask again.', true) };
  }
  if (!loaded) {
    return {
      loaded: null,
      error: text('There is no OpenTV backup to read. Turn on OpenTV Backup in the app (Settings → Library → Backup), let it finish once, then ask again.', true),
    };
  }
  const ops = await opsSince(env, profileId, loaded.asOf);
  return { loaded: { lib: applyOps(loaded.lib, ops), asOf: loaded.asOf, since: ops.length } };
}

async function answer(env: Env, profileId: string, run: (lib: Library) => unknown): Promise<CallToolResult> {
  if (!(await plusFor(env, profileId))) return text(NO_PLUS, true);
  const { loaded, error } = await freshLibrary(env, profileId);
  if (!loaded) return error!;
  // `asOf` on every answer: the last backup, plus `changesSince` relayed after it.
  return text(JSON.stringify({ asOf: loaded.asOf, changesSince: loaded.since, ...(run(loaded.lib) as object) }));
}

// ── writes ───────────────────────────────────────────────────────────────────

/** The relay's name for this server when it speaks. Never registered in `devices`. */
export const ASSISTANT_DEVICE = 'assistant';

export const NO_WRITE_SCOPE =
  'This connection was made when OpenTV could only be read. To let it make changes, remove it in OpenTV (Settings → Claude & ChatGPT) and connect again.';
export const NO_SYNC =
  'Changes reach your phone through Sync, and Sync is not on for this account. Turn it on in OpenTV: Settings → Library → Backup, choose OpenTV Backup (Sync comes on with it), then ask again.';
export const LANDS =
  'It reaches your phone the next time OpenTV is opened there (with Sync on); until then the app does not show it.';

/**
 * Sync is on when a device of this account has used the relay lately and was
 * not removed. A phone with Sync on polls while open and stamps `last_seen`
 * hourly; one that never turned it on has no row at all.
 *
 * ponytail: a phone that switched Sync off keeps its row until RETAIN_DAYS
 * pass, so its owner is told "it lands next time" for up to that long. The
 * phone drops nothing it pulls later, so turning Sync back on still delivers.
 */
export async function syncOn(env: Env, profileId: string, now = Date.now()): Promise<boolean> {
  const cutoff = new Date(now - RETAIN_DAYS * 864e5).toISOString();
  const row = await env.DB.prepare('SELECT 1 AS on_ FROM devices WHERE profile_id = ? AND removed_at IS NULL AND last_seen >= ? LIMIT 1')
    .bind(profileId, cutoff)
    .first();
  return !!row;
}

/** Into the relay, as the phones' own push writes it (`routes/sync.ts`). One ts apart so they apply in order. */
async function relay(env: Env, profileId: string, plan: Extract<Plan, { ops: unknown }>): Promise<void> {
  const now = Date.now();
  const stmt = env.DB.prepare('INSERT INTO sync_ops (profile_id, op_id, device_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?, ?)');
  await env.DB.batch(plan.ops.map((o, i) => stmt.bind(profileId, `${ASSISTANT_DEVICE}:${crypto.randomUUID()}`, ASSISTANT_DEVICE, now + i, o.kind, o.payload)));
}

export async function write(env: Env, profileId: string, canWrite: boolean, plan: (lib: Library) => Plan): Promise<CallToolResult> {
  if (!canWrite) return text(NO_WRITE_SCOPE, true);
  if (!(await plusFor(env, profileId))) return text(NO_PLUS, true);
  if (!(await syncOn(env, profileId))) return text(NO_SYNC, true);
  const { loaded, error } = await freshLibrary(env, profileId);
  if (!loaded) return error!;
  const p = plan(loaded.lib);
  if ('refuse' in p) return text(p.refuse, true);
  await relay(env, profileId, p);
  return text(`${p.done} ${LANDS}`);
}

// ── usage, shape only ────────────────────────────────────────────────────────

/** Which assistant, from the client's id or registered name. Three answers and no free text. */
export function clientLabel(nameOrId: string | null | undefined): 'Claude' | 'ChatGPT' | 'Other' {
  const v = (nameOrId ?? '').toLowerCase();
  if (/claude|anthropic/.test(v)) return 'Claude';
  if (/chatgpt|openai/.test(v)) return 'ChatGPT';
  return 'Other';
}

const labels = new Map<string, ReturnType<typeof clientLabel>>();

/** CIMD clients ARE a URL (ChatGPT's), read as is; a registered client is looked up once per isolate. */
async function clientOf(env: Env, clientId: string | undefined): Promise<ReturnType<typeof clientLabel>> {
  if (!clientId) return 'Other';
  if (/^https?:\/\//.test(clientId)) return clientLabel(clientId);
  const hit = labels.get(clientId);
  if (hit) return hit;
  let label: ReturnType<typeof clientLabel> = 'Other';
  try {
    label = clientLabel((await env.OAUTH_PROVIDER?.lookupClient(clientId))?.clientName);
  } catch {
    // Unknown is "Other"; a count is never worth failing a question over.
  }
  labels.set(clientId, label);
  return label;
}

/**
 * One more call of `tool` today. The tool's NAME and nothing it was given: the
 * arguments never reach this function. Trimmed at 500 days per member, as
 * `profile_days` is.
 */
export async function countCall(env: Env, profileId: string, tool: string, client: string, today = new Date().toISOString().slice(0, 10)): Promise<void> {
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO mcp_calls (profile_id, day, tool, client, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT (profile_id, day, tool, client) DO UPDATE SET n = n + 1',
      ).bind(profileId, today, tool, client),
      env.DB.prepare("DELETE FROM mcp_calls WHERE profile_id = ? AND day < date(?, '-500 days')").bind(profileId, today),
    ]);
  } catch (e) {
    console.error('[mcp] usage not counted', e instanceof Error ? e.message : String(e));
  }
}

// ── the tools ────────────────────────────────────────────────────────────────

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const kind = z.enum(['episodes', 'films', 'all']).optional();
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
/** Not read-only, so Claude and ChatGPT ask the member before each call. Adds only, so not destructive. */
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const year = z.string().regex(/^\d{4}$/, 'YYYY').optional().describe('Release year, to tell two films apart');
const season = z.number().int().min(0).max(1000);
const episode = z.number().int().min(0).max(10000);

const TOOL_TITLES: Record<string, string> = {
  search_library: 'Search my library',
  watch_history: 'What I watched',
  show_progress: 'Show progress',
  stats: 'My stats',
  ratings: 'My ratings',
  lists: 'My watchlist and lists',
  mark_episode_watched: 'Mark episode watched',
  unmark_episode_watched: 'Unmark episode',
  mark_movie_watched: 'Mark film watched',
  rate: 'Rate',
  add_to_watchlist: 'Add to watchlist',
  set_episode_feeling: 'Set episode feeling',
};

export type Caller = { canWrite: boolean; client: string };

export function buildServer(env: Env, profileId: string, caller: Caller = { canWrite: false, client: 'Other' }): McpServer {
  const server = new McpServer({ name: 'OpenTV', version: '2.3.0' });
  // Every tool is registered through this, so every call is counted — by name.
  // A readable title on every tool, at the top and in the annotations: the
  // Claude directory requires one, and both clients show it on approval.
  const register: typeof server.registerTool = ((name: string, config: { annotations?: object }, cb: (...a: unknown[]) => unknown) =>
    server.registerTool(name, { ...config, title: TOOL_TITLES[name] ?? name, annotations: { ...config.annotations, title: TOOL_TITLES[name] ?? name } } as never, (async (...a: unknown[]) => {
      await countCall(env, profileId, name, caller.client);
      return cb(...a);
    }) as never)) as never;
  const ask = (run: (lib: Library) => unknown) => answer(env, profileId, run);
  const change = (plan: (lib: Library) => Plan) => write(env, profileId, caller.canWrite, plan);

  register(
    'search_library',
    {
      description:
        "Find shows and films in the user's own OpenTV watch history by title (case and accent insensitive). For a show: episodes watched, first and last watch dates, favourite/followed/archived, average episode rating. For a film: watched or on the watchlist, latest watch date, rewatches, rating (1-5 stars). Use this first for 'did I watch X?' or 'what did I rate X?'.",
      inputSchema: z.object({ query: z.string().min(1).describe('Part of a title') }),
      annotations: READ_ONLY,
    },
    async ({ query }) => ask((lib) => searchLibrary(lib, query)),
  );

  register(
    'watch_history',
    {
      description:
        'Episodes and films the user watched between two dates (inclusive), newest first, at most 200 items with a count of the rest. Use for "what did I watch last winter / in March 2024".',
      inputSchema: z.object({
        from: isoDay.describe('First day, YYYY-MM-DD'),
        to: isoDay.describe('Last day, YYYY-MM-DD'),
        kind: kind.describe('episodes, films or all (default all)'),
      }),
      annotations: READ_ONLY,
    },
    async ({ from, to, kind: k }) => ask((lib) => watchHistory(lib, from, to, k ?? 'all')),
  );

  register(
    'show_progress',
    {
      description: "How far the user is in one show: per season, episodes watched and the last episode watched with its date.",
      inputSchema: z.object({ title: z.string().min(1).describe('The show title, or part of it') }),
      annotations: READ_ONLY,
    },
    async ({ title }) => ask((lib) => showProgress(lib, title)),
  );

  register(
    'stats',
    {
      description:
        "Totals for all time or one calendar year: episodes, shows, films, hours where runtime is known, the top 10 shows by episodes watched, and the user's rating distribution.",
      inputSchema: z.object({ year: z.number().int().min(1900).max(2100).optional().describe('A year, or omit for all time') }),
      annotations: READ_ONLY,
    },
    async ({ year }) => ask((lib) => stats(lib, year)),
  );

  register(
    'ratings',
    {
      description:
        "The user's rated episodes and films, highest first, at most 100. Ratings are 1-5 stars with halves. Filter by kind and a star range, e.g. min 4.5 for favourites.",
      inputSchema: z.object({
        kind: kind.describe('episodes, films or all (default all)'),
        min: z.number().min(0).max(5).optional().describe('Lowest stars to include'),
        max: z.number().min(0).max(5).optional().describe('Highest stars to include'),
      }),
      annotations: READ_ONLY,
    },
    async ({ kind: k, min, max }) => ask((lib) => ratings(lib, k ?? 'all', min ?? 0, max ?? 5)),
  );

  register(
    'lists',
    {
      description: "The user's film watchlist, followed shows not started yet, favourites, and their own custom lists with titles.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => ask((lib) => lists(lib)),
  );

  // ── changes, approved by the member one at a time ──────────────────────────

  const after = ' The change goes to the phone through Sync and shows there the next time OpenTV is opened.';

  register(
    'mark_episode_watched',
    {
      description:
        "Mark one episode of a show in the user's OpenTV library as watched, today or on a given date. The show must already be in their library." + after,
      inputSchema: z.object({
        show: z.string().min(1).describe('The show title'),
        season: season.describe('Season number'),
        episode: episode.describe('Episode number'),
        watched_at: z.string().optional().describe('When it was watched, YYYY-MM-DD (or a full date and time); omit for now'),
      }),
      annotations: WRITES,
    },
    async ({ show, season: s, episode: e, watched_at }) => change((lib) => planMarkEpisode(lib, show, s, e, watched_at)),
  );

  register(
    'unmark_episode_watched',
    {
      description: 'Remove an episode from the user\'s watch history (every watch of it). Use only when they ask to un-mark it.' + after,
      inputSchema: z.object({ show: z.string().min(1).describe('The show title'), season: season.describe('Season number'), episode: episode.describe('Episode number') }),
      annotations: { ...WRITES, destructiveHint: true, idempotentHint: true },
    },
    async ({ show, season: s, episode: e }) => change((lib) => planUnmarkEpisode(lib, show, s, e)),
  );

  register(
    'mark_movie_watched',
    {
      description:
        "Mark a film watched in the user's OpenTV library. OpenTV dates it today; it cannot take another date. A film not in the library is added first, under exactly the title given." + after,
      inputSchema: z.object({ title: z.string().min(1).describe('The film title, exactly'), year }),
      annotations: WRITES,
    },
    async ({ title, year: y }) => change((lib) => planMarkFilm(lib, title, y)),
  );

  register(
    'rate',
    {
      description:
        'Rate a film, or one episode of a show (give season and episode), 0.5 to 5 stars in halves. A film must already be in the library; a show too.' + after,
      inputSchema: z.object({
        title: z.string().min(1).describe('Film or show title'),
        stars: z.number().min(0.5).max(5).describe('0.5 to 5, halves allowed'),
        season: season.optional().describe('For an episode: season number'),
        episode: episode.optional().describe('For an episode: episode number'),
        year,
      }),
      annotations: { ...WRITES, idempotentHint: true },
    },
    async ({ title, stars, season: s, episode: e, year: y }) => change((lib) => planRate(lib, title, stars, s, e, y)),
  );

  register(
    'add_to_watchlist',
    {
      description:
        "Add a film to the user's OpenTV watchlist (kind film; added under exactly the title given if it is new), or follow a show already in their library (kind show)." + after,
      inputSchema: z.object({ title: z.string().min(1).describe('The title, exactly'), kind: z.enum(['film', 'show']), year }),
      annotations: { ...WRITES, idempotentHint: true },
    },
    async ({ title, kind: k, year: y }) => change((lib) => planWatchlist(lib, title, k, y)),
  );

  register(
    'set_episode_feeling',
    {
      description: `Set (or take back) how an episode made the user feel, one of: ${FEELINGS.join(', ')}. Several can be on at once. The show must be in their library.` + after,
      inputSchema: z.object({
        show: z.string().min(1).describe('The show title'),
        season: season.describe('Season number'),
        episode: episode.describe('Episode number'),
        feeling: z.enum(FEELINGS),
        on: z.boolean().optional().describe('false to take it back; default true'),
      }),
      annotations: { ...WRITES, idempotentHint: true },
    },
    async ({ show, season: s, episode: e, feeling, on }) => change((lib) => planFeeling(lib, show, s, e, feeling, on ?? true)),
  );

  return server;
}

/**
 * The `/mcp` handler, reached only with a valid token (the OAuth provider in
 * `worker.ts` stands in front). `ctx.props` is what `/authorize` stored.
 */
export function mcpFetch(origin: string) {
  const allowedHostnames = [new URL(origin).hostname];
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const { props, auth } = ctx as ExecutionContext & { props?: { profileId?: unknown }; auth: OAuthResourceAuth };
      if (!auth.scope.includes('mcp:read')) return insufficientScope(auth, ['mcp:read']);
      const profileId = typeof props?.profileId === 'string' ? props.profileId : null;
      if (!profileId) return new Response('Forbidden', { status: 403 });
      const caller: Caller = { canWrite: auth.scope.includes('mcp:write'), client: await clientOf(env, auth.clientId) };
      // A server per request: the handler wants a factory, and this one closes
      // over the member. Construction is cheap next to reading R2.
      return createMcpHandler(() => buildServer(env, profileId, caller), { allowedHostnames })(request, env, ctx);
    },
  };
}
