import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { captureError } from './sentry.js';

/**
 * Central error translation.
 *
 * Three tiers, in order: propagate headers a handler explicitly set (rate-limit
 * `retry-after`, for example), turn a Zod failure into a structured 400, pass an
 * intentional non-500 status through verbatim, and only then treat it as an
 * internal fault — logged and reported, with a generic body so nothing about the
 * internals reaches the client.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: any, _req, reply) => {
    if (error.headers) reply.headers(error.headers);
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'validation_error', issues: error.issues });
    }
    if (Number.isInteger(error.statusCode) && error.statusCode !== 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    captureError(error);
    app.log.error(error);
    reply.code(500).send({ error: 'internal_error' });
  });
}
