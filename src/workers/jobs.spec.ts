import { describe, expect, it } from 'vitest';
import { jobsRepo } from '../db/repos.js';
import { jobHandlers, resolveHandler } from '../workers/jobs.js';

describe('jobsRepo.retryDelay', () => {
  it('backs off exponentially and caps the delay', () => {
    expect(jobsRepo.retryDelay(1)).toBe(2_000);
    expect(jobsRepo.retryDelay(2)).toBe(4_000);
    expect(jobsRepo.retryDelay(3)).toBe(8_000);
    expect(jobsRepo.retryDelay(6)).toBe(60_000);
  });
});

describe('resolveHandler', () => {
  it('resolves every registered job type', () => {
    for (const type of Object.keys(jobHandlers)) {
      expect(typeof resolveHandler(type)).toBe('function');
    }
  });

  it('throws on unknown job types', () => {
    expect(() => resolveHandler('definitely.missing')).toThrow(/unknown_job_type/);
  });
});