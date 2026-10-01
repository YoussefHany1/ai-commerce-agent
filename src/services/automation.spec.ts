import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  automationRepo: {
    claim: vi.fn(),
    complete: vi.fn(),
    markFired: vi.fn(),
    listEnabledByTrigger: vi.fn(),
  },
  storeRepo: { get: vi.fn(async () => ({ id: 'store1', name: 'Acme' })) },
  whatsappRepo: { byStore: vi.fn(async () => ({ phoneNumberId: 'pn1' })) },
  conversationRepo: { addMessage: vi.fn() },
  sendText: vi.fn(async () => true),
  sendOverBaileys: vi.fn(async () => true),
  withTenant: vi.fn(async (_id: string, fn: (tx: unknown) => unknown) => fn({})),
}));

vi.mock('../db/repos.js', () => ({
  automationRepo: mocks.automationRepo,
  storeRepo: mocks.storeRepo,
  whatsappRepo: mocks.whatsappRepo,
  conversationRepo: mocks.conversationRepo,
}));
vi.mock('../db/client.js', () => ({ withTenant: mocks.withTenant }));
vi.mock('../integrations/whatsapp.js', () => ({ sendText: mocks.sendText }));
vi.mock('./whatsappInbound.js', () => ({ sendOverBaileys: mocks.sendOverBaileys }));

const { isInCooldown, keywordsFor, matchesKeyword, renderTemplate, runKeywordAutomation } = await import('./automation.js');
import type { AutomationRule } from '../db/schema.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeRepo.get.mockResolvedValue({ id: 'store1', name: 'Acme' });
  mocks.whatsappRepo.byStore.mockResolvedValue({ phoneNumberId: 'pn1' });
  mocks.sendText.mockResolvedValue(true);
});

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule1',
    storeId: 'store1',
    triggerType: 'clicked_no_conversion',
    triggerConfig: {},
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

describe('matchesKeyword', () => {
  it('matches case-insensitively on a substring', () => {
    expect(matchesKeyword("What's the PRICE of this?", ['price'])).toBe(true);
  });

  it('matches any keyword in the list', () => {
    expect(matchesKeyword('do you ship to cairo?', ['price', 'ship'])).toBe(true);
  });

  it('does not match when no keyword is present', () => {
    expect(matchesKeyword('hello there', ['price', 'ship'])).toBe(false);
  });

  it('ignores blank keywords instead of matching everything', () => {
    expect(matchesKeyword('hello there', ['   '])).toBe(false);
  });

  it('returns false for an empty keyword list', () => {
    expect(matchesKeyword('anything', [])).toBe(false);
  });
});

describe('runKeywordAutomation', () => {
  it('replies with the rule body when a keyword matches', async () => {
    mocks.automationRepo.listEnabledByTrigger.mockResolvedValue([rule({ triggerType: 'keyword', triggerConfig: { keywords: ['hi123'] } })]);
    mocks.automationRepo.claim.mockResolvedValue('log-1');
    mocks.whatsappRepo.byStore.mockResolvedValue({ phoneNumberId: 'pn1' });
    mocks.sendText.mockResolvedValue(true);

    const out = await runKeywordAutomation('store1', { conversationId: 'c1', phone: '966500000000', text: 'say hi123 please' });
    expect(out).toEqual({ ruleId: 'rule1', body: 'hello' });
    expect(mocks.sendText).toHaveBeenCalledWith('966500000000', 'hello', expect.anything());
    expect(mocks.automationRepo.complete).toHaveBeenCalledWith('store1', 'log-1', 'sent', 'hello', null);
  });

  it('sends nothing when no keyword matches', async () => {
    mocks.automationRepo.listEnabledByTrigger.mockResolvedValue([rule({ triggerType: 'keyword', triggerConfig: { keywords: ['hi123'] } })]);
    const out = await runKeywordAutomation('store1', { conversationId: 'c1', phone: '966500000000', text: 'what is the price' });
    expect(out).toBeNull();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('renders template tokens in the reply', async () => {
    mocks.automationRepo.listEnabledByTrigger.mockResolvedValue([
      rule({ triggerType: 'keyword', triggerConfig: { keywords: ['price'] }, action: { type: 'whatsapp_text', text: 'hi {customerName}' } }),
    ]);
    mocks.automationRepo.claim.mockResolvedValue('log-1');
    mocks.whatsappRepo.byStore.mockResolvedValue({ phoneNumberId: 'pn1' });
    mocks.sendText.mockResolvedValue(true);

    const out = await runKeywordAutomation('store1', { conversationId: 'c1', phone: '9665', text: 'PRICE?', customerName: 'Sara' });
    expect(out?.body).toBe('hi Sara');
  });

  it('dedupes on the inbound message, so a repeated keyword replies again', async () => {
    mocks.automationRepo.listEnabledByTrigger.mockResolvedValue([rule({ triggerType: 'keyword', triggerConfig: { keywords: ['hi123'] } })]);
    mocks.automationRepo.claim.mockResolvedValue('log-1');

    const first = await runKeywordAutomation('store1', { conversationId: 'c1', messageId: 'm1', phone: '9665', text: 'hi123' });
    const second = await runKeywordAutomation('store1', { conversationId: 'c1', messageId: 'm2', phone: '9665', text: 'hi123' });

    expect(first).toEqual({ ruleId: 'rule1', body: 'hello' });
    expect(second).toEqual({ ruleId: 'rule1', body: 'hello' });
    // Scoping dedupe to the conversation instead made a rule answer each customer once
    // ever: the second keyword hit the unique conflict and fell through to the AI.
    const scopes = mocks.automationRepo.claim.mock.calls.map((c) => (c[5] as { scope: string }).scope);
    expect(scopes).toEqual(['message', 'message']);
    expect(mocks.automationRepo.claim.mock.calls[0]![5]).toMatchObject({ scope: 'message', key: 'm1' });
    expect(mocks.automationRepo.claim.mock.calls[1]![5]).toMatchObject({ scope: 'message', key: 'm2' });
  });

  it('sends nothing when the same inbound message already fired', async () => {
    mocks.automationRepo.listEnabledByTrigger.mockResolvedValue([rule({ triggerType: 'keyword', triggerConfig: { keywords: ['hi123'] } })]);
    mocks.automationRepo.claim.mockResolvedValue(null);

    const out = await runKeywordAutomation('store1', { conversationId: 'c1', messageId: 'm1', phone: '9665', text: 'hi123' });
    expect(out).toBeNull();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('does nothing when the store has no keyword rules', async () => {
    mocks.automationRepo.listEnabledByTrigger.mockResolvedValue([]);
    const out = await runKeywordAutomation('store1', { conversationId: 'c1', phone: '9665', text: 'hi123' });
    expect(out).toBeNull();
  });
});

describe('keywordsFor', () => {
  it('drops blank and non-string entries', () => {
    const r = rule({ triggerConfig: { keywords: ['price', '  ', 42 as unknown as string] } });
    expect(keywordsFor(r)).toEqual(['price']);
  });

  it('returns an empty list when triggerConfig is missing', () => {
    const r = rule();
    delete (r as { triggerConfig?: unknown }).triggerConfig;
    expect(keywordsFor(r)).toEqual([]);
  });
});