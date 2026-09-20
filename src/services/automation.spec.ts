import { describe, expect, it } from 'vitest';
import { isInCooldown, renderTemplate } from './automation.js';
import type { AutomationRule } from '../db/schema.js';

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule1',
    storeId: 'store1',
    triggerType: 'clicked_no_conversion',
    action: { type: 'whatsapp_text', text: 'hello' },
    enabled: true,
    cooldownMinutes: 1440,
    lookbackHours: 72,
    lastFiredAt: null,
    createdAt: new Date(),
    ...overrides,
  } as AutomationRule;
}

describe('renderTemplate', () => {
  it('interpolates known tokens', () => {
    const out = renderTemplate('Hi {customerName}, check {productTitle} — {productLink}', {
      customerName: 'Lina',
      productTitle: 'Webhook Tee',
      productLink: 'https://x.test/p/1',
    });
    expect(out).toBe('Hi Lina, check Webhook Tee — https://x.test/p/1');
  });

  it('clears unknown tokens', () => {
    expect(renderTemplate('Hi {customerName}. {unknownToken}', { customerName: 'Sara' })).toBe('Hi Sara. ');
  });

  it('handles nullish values as empty', () => {
    expect(renderTemplate('[{productTitle}]', { productTitle: null })).toBe('[]');
  });
});

describe('isInCooldown', () => {
  it('returns false when the rule never fired', () => {
    expect(isInCooldown(rule())).toBe(false);
  });

  it('returns true within the cooldown window', () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const r = rule({ lastFiredAt: new Date('2026-01-01T23:00:00Z'), cooldownMinutes: 1440 });
    expect(isInCooldown(r, now)).toBe(true);
  });

  it('returns false after the cooldown elapsed', () => {
    const now = new Date('2026-01-03T00:00:00Z');
    const r = rule({ lastFiredAt: new Date('2026-01-01T00:00:00Z'), cooldownMinutes: 1440 });
    expect(isInCooldown(r, now)).toBe(false);
  });
});