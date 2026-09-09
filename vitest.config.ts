import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Node's ESM loader resolves an externalized dependency's imports itself, so
    // the alias below only reaches the OAuth provider once vite transforms it.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
  resolve: {
    alias: {
      // Supplied by workerd at runtime and by nothing at all under node.
      'cloudflare:workers': fileURLToPath(
        new URL('./test/stubs/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
});
