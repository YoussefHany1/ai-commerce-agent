import { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

export async function dashboard(app: FastifyInstance) {
  let dashboardHtml: string | null = null;
  app.get('/dashboard', async (_req, reply) => {
    if (dashboardHtml === null) {
      dashboardHtml = await readFile(join(ROOT, 'public', 'dashboard.html'), 'utf8');
    }
    return reply.type('text/html').send(dashboardHtml);
  });

  // Suppress browser favicon 404 errors
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
}