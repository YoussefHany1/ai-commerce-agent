import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { z } from 'zod';
import { api } from './routes/api.js';
import { oauth } from './routes/oauth.js';
import { webhooks, registerRawBody } from './routes/webhooks.js';
import { whatsapp } from './routes/whatsapp.js';
import { billing } from './routes/billing.js';
import { analytics } from './routes/analytics.js';
import { jobs as jobsRoutes } from './routes/jobs.js';
import { session as sessionRoutes } from './routes/session.js';
import { automation as automationRoutes } from './routes/automation.js';
import { pdpl as pdplRoutes } from './routes/pdpl.js';
import { dashboard } from './routes/dashboard.js';
import { startCatalogSync } from './workers/catalogSync.js';
import { startMetricsRollup } from './workers/metricsRollup.js';
import { startJobsWorker } from './workers/jobs.js';
import { startAutomationWorker } from './workers/automation.js';
import { startRetentionWorker } from './workers/retention.js';
import { config } from './config.js';
import { initSentry, captureError } from './lib/sentry.js';

void initSentry();

const app = Fastify({ logger: true, trustProxy: config.trustProxy });

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

process.on('unhandledRejection', (reason) => {
  captureError(reason);
  app.log.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  captureError(err);
  app.log.error({ err }, 'uncaughtException');
  process.exit(1);
});

await app.register(cors, {
  origin: config.CORS_ORIGINS
    ? config.CORS_ORIGINS === '*'
      ? true
      : config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : config.APP_BASE_URL,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Api-Key', 'X-Store-Id'],
});
await app.register(formbody);

app.get('/', async () => ({ name: 'AI Commerce Agent', version: '0.2.0' }));

await registerRawBody(app);
await api(app);
await oauth(app);
await sessionRoutes(app);
await webhooks(app);
await whatsapp(app);
await billing(app);
await analytics(app);
await jobsRoutes(app);
await automationRoutes(app);
await pdplRoutes(app);
await dashboard(app);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
app.log.info(`listening on port ${config.PORT}`);

const workers = [
  startCatalogSync(),
  startMetricsRollup(),
  startJobsWorker(),
  startAutomationWorker(),
  startRetentionWorker(),
];

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'graceful shutdown started');
  workers.forEach((w) => w.stop());
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));