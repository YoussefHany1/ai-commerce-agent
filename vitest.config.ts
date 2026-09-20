import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/db/schema.ts',
        'src/db/client.ts',
        'src/routes/**',
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