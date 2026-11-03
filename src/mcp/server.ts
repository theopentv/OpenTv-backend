import { insufficientScope, type OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import type { Env } from '@/env';
import { plusFor } from '@/middleware';
import { bestBackupKey } from '@/routes/backup';
import { lists, parseLibrary, ratings, searchLibrary, showProgress, stats, watchHistory, type Library } from '@/mcp/library';

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
 * WRITE TOOLS GO HERE LATER — mark watched, rate, add to watchlist — as
 * `sync_ops` from an "assistant" device so the phones apply them, behind an
 * `mcp:write` scope the client steps up to with `insufficientScope`.
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

async function answer(env: Env, profileId: string, run: (lib: Library) => unknown): Promise<CallToolResult> {
  if (!(await plusFor(env, profileId))) {
    return text('This OpenTV account no longer has OpenTV Plus, which the Claude and ChatGPT connection needs. Renew Plus in the OpenTV app to use it again.', true);
  }
  let loaded: Loaded | null;
  try {
    loaded = await loadLibrary(env, profileId);
  } catch (e) {
    console.error('[mcp] backup unreadable', e instanceof Error ? e.message : String(e));
    return text('The OpenTV backup could not be read. Open OpenTV so it backs up again, then ask again.', true);
  }
  if (!loaded) {
    return text('There is no OpenTV backup to read. Turn on OpenTV Backup in the app (Settings → Backup), let it finish once, then ask again.', true);
  }
  // `asOf` on every answer: this is the last backup, not the phone right now.
  return text(JSON.stringify({ asOf: loaded.asOf, ...(run(loaded.lib) as object) }));
}

// ── the tools ────────────────────────────────────────────────────────────────

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const kind = z.enum(['episodes', 'films', 'all']).optional();
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export function buildServer(env: Env, profileId: string): McpServer {
  const server = new McpServer({ name: 'OpenTV', version: '2.3.0' });
  const ask = (run: (lib: Library) => unknown) => answer(env, profileId, run);

  server.registerTool(
    'search_library',
    {
      description:
        "Find shows and films in the user's own OpenTV watch history by title (case and accent insensitive). For a show: episodes watched, first and last watch dates, favourite/followed/archived, average episode rating. For a film: watched or on the watchlist, latest watch date, rewatches, rating (1-5 stars). Use this first for 'did I watch X?' or 'what did I rate X?'.",
      inputSchema: z.object({ query: z.string().min(1).describe('Part of a title') }),
      annotations: READ_ONLY,
    },
    async ({ query }) => ask((lib) => searchLibrary(lib, query)),
  );

  server.registerTool(
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

  server.registerTool(
    'show_progress',
    {
      description: "How far the user is in one show: per season, episodes watched and the last episode watched with its date.",
      inputSchema: z.object({ title: z.string().min(1).describe('The show title, or part of it') }),
      annotations: READ_ONLY,
    },
    async ({ title }) => ask((lib) => showProgress(lib, title)),
  );

  server.registerTool(
    'stats',
    {
      description:
        "Totals for all time or one calendar year: episodes, shows, films, hours where runtime is known, the top 10 shows by episodes watched, and the user's rating distribution.",
      inputSchema: z.object({ year: z.number().int().min(1900).max(2100).optional().describe('A year, or omit for all time') }),
      annotations: READ_ONLY,
    },
    async ({ year }) => ask((lib) => stats(lib, year)),
  );

  server.registerTool(
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

  server.registerTool(
    'lists',
    {
      description: "The user's film watchlist, followed shows not started yet, favourites, and their own custom lists with titles.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => ask((lib) => lists(lib)),
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
      // A server per request: the handler wants a factory, and this one closes
      // over the member. Construction is cheap next to reading R2.
      return createMcpHandler(() => buildServer(env, profileId), { allowedHostnames })(request, env, ctx);
    },
  };
}
