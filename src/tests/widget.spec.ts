import { describe, expect, test } from 'vitest';
import {
  EMBED_KEY_PATTERN,
  allowedWidgetOrigins,
  generateEmbedKey,
  originAllowed,
} from '../lib/widget.js';

/**
 * The origin check is the only thing standing between a leaked embed key and any
 * site on the internet, so these are deliberately exhaustive about the ways an
 * origin can be spelled.
 */
const store = (over: Partial<{ shopDomain: string | null; settings: unknown }> = {}) =>
  ({
    shopDomain: over.shopDomain === undefined ? 'shop.myshopify.com' : over.shopDomain,
    settings: (over.settings ?? null) as Record<string, unknown> | null,
  }) as never;

describe('generateEmbedKey', () => {
  test('produces a key matching the pattern, so it is accepted by the guard', () => {
    expect(generateEmbedKey()).toMatch(EMBED_KEY_PATTERN);
  });

  test('is unguessable enough that a key cannot be enumerated', () => {
    // 32 hex chars is 128 bits; the shape test alone would pass for `aca_pub_` + 32
    // zeros, so assert real entropy across draws.
    const keys = new Set(Array.from({ length: 50 }, () => generateEmbedKey()));
    expect(keys.size).toBe(50);
  });

  test('never collides with the secret store-key shape', () => {
    // The two must stay distinguishable: an embed key is public and must never be
    // accepted where a store API key is expected. The secret pattern is assembled
    // rather than pasted, so nothing in the repo looks like a live credential.
    const storeKeyPattern = new RegExp(`^sk_live_[0-9a-f]{${64}}$`);
    expect(storeKeyPattern.test(generateEmbedKey())).toBe(false);
  });
});

describe('allowedWidgetOrigins', () => {
  test('includes the shop domain', () => {
    expect(allowedWidgetOrigins(store())).toContain('shop.myshopify.com');
  });

  test('includes explicitly configured custom domains', () => {
    const s = store({ shopDomain: 'shop.myshopify.com', settings: { widgetOrigins: ['www.example.com'] } });
    expect(allowedWidgetOrigins(s)).toEqual(
      expect.arrayContaining(['shop.myshopify.com', 'www.example.com']),
    );
  });

  test('normalises a configured origin down to its host', () => {
    const s = store({ settings: { widgetOrigins: ['https://www.example.com/path?x=1'] } });
    expect(allowedWidgetOrigins(s)).toContain('www.example.com');
  });

  test('ignores a non-array or non-string configuration instead of throwing', () => {
    expect(allowedWidgetOrigins(store({ settings: { widgetOrigins: 'nope' } }))).toEqual([
      'shop.myshopify.com',
    ]);
    expect(allowedWidgetOrigins(store({ settings: { widgetOrigins: [1, null, {}] } }))).toEqual([
      'shop.myshopify.com',
    ]);
  });

  test('yields nothing for a store with no shop domain and no configuration', () => {
    expect(allowedWidgetOrigins(store({ shopDomain: null }))).toEqual([]);
  });
});

describe('originAllowed', () => {
  test('accepts the store’s own storefront', () => {
    expect(originAllowed('https://shop.myshopify.com', store())).toBe(true);
  });

  test('accepts a configured custom domain', () => {
    const s = store({ settings: { widgetOrigins: ['www.example.com'] } });
    expect(originAllowed('https://www.example.com', s)).toBe(true);
  });

  test('rejects any other origin — the whole point of the check', () => {
    expect(originAllowed('https://evil.test', store())).toBe(false);
    expect(originAllowed('https://shop.myshopify.com.evil.test', store())).toBe(false);
  });

  test('is case-insensitive, since hosts are', () => {
    expect(originAllowed('https://SHOP.MyShopify.com', store())).toBe(true);
  });

  test('ignores the port so a merchant can preview locally', () => {
    expect(originAllowed('http://localhost:3000', store({ shopDomain: 'localhost' }))).toBe(true);
  });

  test('accepts a missing Origin, for same-origin and non-browser clients', () => {
    // A browser always sends Origin on a cross-origin POST, so an absent one is not
    // an attacker trying to dodge the check.
    expect(originAllowed(undefined, store())).toBe(true);
  });

  test('rejects a malformed origin rather than treating it as absent', () => {
    expect(originAllowed('not a url', store())).toBe(false);
    expect(originAllowed('null', store())).toBe(false);
  });

  test('rejects everything when the store has no known origin', () => {
    // Better to refuse than to allow an unconfigured store's widget to work anywhere.
    const s = store({ shopDomain: null });
    expect(originAllowed('https://anything.test', s)).toBe(false);
  });
});
