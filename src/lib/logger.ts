import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['accessToken', 'refreshToken', 'authorization', 'password', 'key', 'apiKey'],
    censor: '[REDACTED]',
  },
});