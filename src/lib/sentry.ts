import * as Sentry from '@sentry/node';
import { config } from '../config.js';

export function initSentry(): boolean {
  if (!config.SENTRY_DSN) return false;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0,
  });
  return true;
}

export function captureError(err: unknown): void {
  if (!config.SENTRY_DSN) return;
  Sentry.captureException(err);
}