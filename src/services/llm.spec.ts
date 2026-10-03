import { test, expect, describe } from 'vitest';
import { toChatMessages, toChatTools, hasOpenAI, hasOpenRouter, isRetryable } from './llm.js';

describe('llm chat-completions conversion', () => {
  test('maps developer role to system and keeps user content', () => {
    const msgs = toChatMessages([
      { role: 'developer', content: 'أنت موظف مبيعات' },
      { role: 'user', content: 'السلام عليكم' },
      { role: 'assistant', content: 'أهلاً بك' },
    ]);
    expect(msgs).toEqual([
      { role: 'system', content: 'أنت موظف مبيعات' },
      { role: 'user', content: 'السلام عليكم' },
      { role: 'assistant', content: 'أهلاً بك' },
    ]);
  });

  test('groups function calls into assistant tool_calls and outputs into tool messages', () => {
    const msgs = toChatMessages([
      { role: 'user', content: 'عندك سيروم؟' },
      { type: 'function_call', call_id: 'call-1', name: 'search_products', arguments: '{"query":"سيروم"}' },
      { type: 'function_call', call_id: 'call-2', name: 'list_products', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: '[{"title":"سيروم"}]' },
      { type: 'function_call_output', call_id: 'call-2', output: '[]' },
    ]);
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toEqual({ role: 'user', content: 'عندك سيروم؟' });
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call-1', type: 'function', function: { name: 'search_products', arguments: '{"query":"سيروم"}' } },
        { id: 'call-2', type: 'function', function: { name: 'list_products', arguments: '{}' } },
      ],
    });
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: '[{"title":"سيروم"}]' });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call-2', content: '[]' });
  });

  test('round-trips a single round of tool calls ending in a plain message', () => {
    const msgs = toChatMessages([
      { type: 'function_call', call_id: 'call-9', name: 'get_customer', arguments: '{"identifier":"x"}' },
      { type: 'function_call_output', call_id: 'call-9', output: '{"id":"c1"}' },
      { role: 'user', content: 'شكرا' },
    ]);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe('assistant');
    expect((msgs[0].tool_calls as Array<{ id: string }>)[0].id).toBe('call-9');
    expect(msgs[1]).toEqual({ role: 'tool', tool_call_id: 'call-9', content: '{"id":"c1"}' });
    expect(msgs[2]).toEqual({ role: 'user', content: 'شكرا' });
  });

  test('falls back to user role when no role is present', () => {
    const msgs = toChatMessages([{ content: 'مرحبا' }]);
    expect(msgs[0].role).toBe('user');
  });
});

describe('llm tool conversion', () => {
  test('omits strict and wraps function shape for chat completions', () => {
    const tools = toChatTools([
      { type: 'function', name: 'search_products', description: 'ابحث', parameters: { type: 'object' }, strict: true },
    ]);
    expect(tools).toEqual([
      { type: 'function', function: { name: 'search_products', description: 'ابحث', parameters: { type: 'object' } } },
    ]);
  });

  test('returns undefined for empty tool lists', () => {
    expect(toChatTools([])).toBeUndefined();
    expect(toChatTools(undefined)).toBeUndefined();
  });
});

describe('provider availability flags', () => {
  test('flags are booleans derived from config', () => {
    expect(typeof hasOpenAI).toBe('boolean');
    expect(typeof hasOpenRouter).toBe('boolean');
  });
});

describe('llm fallback retry policy', () => {
  test('retries only on transient HTTP statuses', () => {
    expect(isRetryable({ status: 408 })).toBe(true);
    expect(isRetryable({ status: 409 })).toBe(true);
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 401 })).toBe(false);
    expect(isRetryable({ status: 403 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  test('treats status-less errors (network/timeout) as retryable', () => {
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
    expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true);
  });

  test('accepts statusCode as an alias for status', () => {
    expect(isRetryable({ statusCode: 503 })).toBe(true);
    expect(isRetryable({ statusCode: 422 })).toBe(false);
  });
});