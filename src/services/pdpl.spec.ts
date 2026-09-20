import { describe, expect, it } from 'vitest';
import { retentionCutoffs } from './pdpl.js';

describe('retentionCutoffs', () => {
  it('computes cutoff dates from a reference point', () => {
    const now = new Date('2026-09-14T12:00:00Z');
    const c = retentionCutoffs(now, { conversationsDays: 365, attributionsDays: 30, eventsDays: 7, customersDays: 730 });
    expect(c.conversations.toISOString()).toBe('2025-09-14T12:00:00.000Z');
    expect(c.attributions.toISOString()).toBe('2026-08-15T12:00:00.000Z');
    expect(c.events.toISOString()).toBe('2026-09-07T12:00:00.000Z');
    expect(c.customers.toISOString()).toBe('2024-09-14T12:00:00.000Z');
  });
});