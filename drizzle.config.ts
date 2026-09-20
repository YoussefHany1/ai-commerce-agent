import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.PGADMIN_URL?.trim() || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ai_commerce_agent',
  },
});