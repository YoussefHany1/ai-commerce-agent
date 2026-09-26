import { FastifyInstance } from 'fastify';

/**
 * Suppresses the browser's automatic favicon request so it does not log a 404 on
 * every page load.
 *
 * This used to also serve the standalone single-file dashboard at `/dashboard`.
 * That page is gone: it prompted for the operator's API key in the browser and
 * held it in localStorage, which is precisely the exposure the dashboard BFF
 * exists to remove. The operator UI is the separate web service.
 */
export async function favicon(app: FastifyInstance) {
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
}
