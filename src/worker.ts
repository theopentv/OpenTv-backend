import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import api from '@/index';
import type { Env } from '@/env';
import { mcpFetch } from '@/mcp/server';
import { oauthOptions } from '@/mcp/oauth-options';

/**
 * WRANGLER'S ENTRY POINT since 2.3.0 — `src/index.ts` is still the whole API.
 *
 * One layer goes in front of it: the OAuth provider that guards `/mcp` (OpenTV
 * inside Claude and ChatGPT, `src/mcp/`). It answers its own few paths —
 * `/.well-known/oauth-*`, `/oauth/token`, `/oauth/register` — checks the token
 * on `/mcp`, and hands EVERY other request to the Hono app untouched, with its
 * helpers added to `env` as `OAUTH_PROVIDER` for `/authorize` and the
 * connection routes.
 *
 * A SEPARATE FILE, NOT AN EDIT TO index.ts, because the library imports
 * `cloudflare:workers`, which does not resolve under Node — and `selfhost/` and
 * the test suite both import index.ts under Node. So a self-hosted instance has
 * no MCP server (it has no Durable Objects either); everything else is the same
 * code on both.
 *
 * Built per origin, lazily: the resource URL every token is bound to comes from
 * `MCP_ORIGIN`, which is an env var and so unknown at module scope. One origin
 * in production, so one instance.
 */
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>(oauthOptions(origin, { apiHandler: mcpFetch(origin), defaultHandler: { fetch: api.fetch } }));
    providers.set(origin, p);
  }
  return p;
}

export { EpisodeRoom } from '@/rooms';

export default {
  fetch(request, env, ctx) {
    const origin = (env.MCP_ORIGIN || new URL(request.url).origin).replace(/\/+$/, '');
    return providerFor(origin).fetch(request, env, ctx);
  },
  scheduled: api.scheduled,
} satisfies ExportedHandler<Env>;
