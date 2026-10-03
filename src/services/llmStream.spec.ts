import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The provider clients are built at import time from config, so the mock and the
// env vars must be in place before `./llm.js` is imported (done dynamically in
// beforeAll). A single mock class serves both the Responses API and the chat
// completions surface the two providers use.
const state = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
  chatCreate: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: state.responsesCreate };
    chat = { completions: { create: state.chatCreate } };
  },
}));

let llm: typeof import('./llm.js');

beforeAll(async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  llm = await import('./llm.js');
});

afterEach(() => {
  vi.clearAllMocks();
});

async function* toAsync<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe('OpenAI streaming', () => {
  it('forwards text deltas and returns the terminal response object', async () => {
    const finalResponse = { output_text: 'مرحبا بك', output: [{ type: 'message' }] };
    state.responsesCreate.mockResolvedValue(
      toAsync([
        { type: 'response.output_text.delta', delta: 'مرحبا' },
        { type: 'response.output_text.delta', delta: ' بك' },
        { type: 'response.completed', response: finalResponse },
      ]),
    );

    const deltas: string[] = [];
    const res = await llm.chatWithFallbackStream(
      [{ role: 'user', content: 'hi' }],
      undefined,
      undefined,
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual(['مرحبا', ' بك']);
    expect(res.output_text).toBe('مرحبا بك');
    expect(res.output).toEqual([{ type: 'message' }]);
    expect(state.chatCreate).not.toHaveBeenCalled();
  });

  it('rejects when the stream ends without a completed event', async () => {
    state.responsesCreate.mockResolvedValue(
      toAsync([{ type: 'response.output_text.delta', delta: 'x' }]),
    );

    await expect(
      llm.chatWithFallbackStream([{ role: 'user', content: 'hi' }], undefined, undefined, () => {}),
    ).rejects.toThrow('llm_stream_incomplete');
  });
});

describe('streaming fallback policy', () => {
  it('does not fall back once a delta has been emitted', async () => {
    state.responsesCreate.mockResolvedValue(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'مر' };
        throw new Error('provider died');
      })(),
    );

    const deltas: string[] = [];
    await expect(
      llm.chatWithFallbackStream(
        [{ role: 'user', content: 'hi' }],
        undefined,
        undefined,
        (d) => deltas.push(d),
      ),
    ).rejects.toThrow('provider died');

    expect(deltas).toEqual(['مر']);
    expect(state.chatCreate).not.toHaveBeenCalled();
  });

  it('does not fall back on a non-retryable OpenAI error', async () => {
    state.responsesCreate.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));

    await expect(
      llm.chatWithFallbackStream([{ role: 'user', content: 'hi' }], undefined, undefined, () => {}),
    ).rejects.toThrow('bad request');
    expect(state.chatCreate).not.toHaveBeenCalled();
  });

  it('falls back before any delta and accumulates indexed tool-call deltas', async () => {
    state.responsesCreate.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 503 }));
    state.chatCreate.mockResolvedValue(
      toAsync([
        { choices: [{ delta: { content: 'مرحبا' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-1', function: { name: 'search_products', arguments: '{"query":' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"سيروم"}' } }] } }] },
      ]),
    );

    const deltas: string[] = [];
    const res = await llm.chatWithFallbackStream(
      [{ role: 'user', content: 'سيروم؟' }],
      undefined,
      undefined,
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual(['مرحبا']);
    expect(res.output_text).toBe('مرحبا');
    expect(res.output).toEqual([
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'search_products',
        arguments: '{"query":"سيروم"}',
      },
    ]);
  });
});
