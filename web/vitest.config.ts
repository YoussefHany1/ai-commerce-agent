import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // `server-only` exists to throw when a server module is pulled into a client
      // bundle. Under Vitest there is no bundler condition to satisfy, so point the
      // marker at its empty implementation instead of letting it throw on import.
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.spec.ts', 'app/**/*.spec.ts', 'proxy.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['lib/server/**/*.ts', 'proxy.ts'],
      reporter: ['text-summary'],
    },
  },
});
