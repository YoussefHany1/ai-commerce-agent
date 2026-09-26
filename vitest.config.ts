import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    include: ['src/**/*.spec.ts'],
    // CI runs `npm ci && npm run test` on a cold cache every push, so the first
    // test in a file to pull in the full module graph (openai + drizzle + postgres
    // + redis) pays the whole transform cost against the 5s default and fails on
    // timeout even though nothing is wrong. Warm runs finish in ~4s, so this only
    // moves the ceiling, it does not hide a genuinely slow test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/db/schema.ts',
        'src/db/client.ts',
        'src/server.ts',
        'src/index.ts',
        'src/types.ts',
        'src/**/index.ts',
      ],
      thresholds: {
        lines: 32,
        functions: 30,
        statements: 31,
        branches: 25,
      },
    },
  },
});