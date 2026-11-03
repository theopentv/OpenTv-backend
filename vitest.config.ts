import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The OAuth library imports `cloudflare:workers`; inlined so the alias
    // below reaches inside it. See test/stubs/cloudflare-workers.ts.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
  resolve: {
    alias: {
      '@': new URL('./src/', import.meta.url).pathname,
      'cloudflare:workers': new URL('./test/stubs/cloudflare-workers.ts', import.meta.url).pathname,
    },
  },
});
