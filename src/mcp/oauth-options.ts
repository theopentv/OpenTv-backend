import type { OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import type { Env } from '@/env';

/**
 * The OAuth server's settings, in one place — so the Worker (`src/worker.ts`)
 * and the test suite build the same thing, and a test about who may revoke a
 * connection is a test about the real configuration.
 *
 * A TYPE-ONLY import of the library on purpose. Its runtime pulls in
 * `cloudflare:workers`, which does not resolve under Node, and this module is
 * reachable from the tests and from nothing that `selfhost/` loads.
 *
 * CHOICES, and why:
 * - `mcp:read` is what every token needs. `mcp:write` lets the write tools
 *   relay changes (sync_ops from an "assistant" device). Every connection
 *   approved since the write tools arrived carries both; one approved before
 *   kept read-only and is told to connect again, never silently widened.
 * - CIMD and dynamic registration both on. ChatGPT identifies itself with a
 *   Client ID Metadata Document; Claude and most other clients still register.
 *   CIMD needs `global_fetch_strictly_public` in wrangler.jsonc, without which
 *   the library quietly stops advertising it.
 * - Refresh tokens live 90 days and slide while used. A connection somebody
 *   uses weekly should not need a new code from the phone every month; one
 *   abandoned for a season expires on its own.
 */
export const MCP_SCOPES = ['mcp:read', 'mcp:write', 'offline_access'];

export function oauthOptions(
  origin: string,
  handlers: Pick<OAuthProviderOptions<Env>, 'apiHandler' | 'defaultHandler'>,
): OAuthProviderOptions<Env> {
  return {
    apiRoute: '/mcp',
    ...handlers,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: MCP_SCOPES,
    requiredScopes: ['mcp:read'],
    clientIdMetadataDocumentEnabled: true,
    refreshTokenTTL: 90 * 86400,
    refreshTokenIdleTTL: 90 * 86400,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      resource_name: 'OpenTV',
    },
  };
}
