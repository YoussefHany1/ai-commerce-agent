import OpenAI from 'openai';
import { config } from '../config.js';

const REQUEST_TIMEOUT_MS = config.LLM_REQUEST_TIMEOUT_MS;

export type ChatToolDef = OpenAI.Responses.FunctionTool;

export type LlmCallOptions = { signal?: AbortSignal };

/** Receives streamed assistant text as it is produced. */
export type DeltaHandler = (delta: string) => void;

export type LlmItem = {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  [k: string]: unknown;
};

export type LlmResult = { output_text?: string; output?: unknown[] };

function resolveBaseUrl(): string {
  const base = config.OPENROUTER_BASE_URL.replace(/\/+$/, '');
  return base || 'https://openrouter.ai/api/v1';
}

function buildOpenAI(): OpenAI | null {
  if (!config.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
}

function buildOpenRouter(): OpenAI | null {
  if (!config.OPENROUTER_API_KEY) return null;
  return new OpenAI({
    apiKey: config.OPENROUTER_API_KEY,
    baseURL: resolveBaseUrl(),
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 1,
    defaultHeaders: {
      'HTTP-Referer': config.APP_BASE_URL,
      'X-Title': 'AI Commerce Agent',
    },
  });
}

const openai = buildOpenAI();
const openrouter = buildOpenRouter();

export const hasOpenAI = !!openai;
export const hasOpenRouter = !!openrouter;

function stringifyContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// Maps OpenAI Responses-API input items onto chat-completions messages so the
// same tool loop can drive either provider (OpenRouter exposes chat completions).
export function toChatMessages(input: unknown[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  let assistantToolCalls: Array<Record<string, unknown>> = [];
  for (const item of input as LlmItem[]) {
    if (item?.type === 'function_call') {
      assistantToolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments ?? '{}' },
      });
      continue;
    }
    if (assistantToolCalls.length) {
      messages.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });
      assistantToolCalls = [];
    }
    if (item?.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: stringifyContent(item.output ?? ''),
      });
      continue;
    }
    if (item?.content !== undefined) {
      messages.push({
        role: item.role === 'developer' ? 'system' : (item.role ?? 'user'),
        content: item.content,
      });
    }
  }
  if (assistantToolCalls.length) {
    messages.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });
  }
  return messages;
}

export function toChatTools(tools: ChatToolDef[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function openaiRequest(input: unknown[], tools: ChatToolDef[] | undefined) {
  return {
    model: config.OPENAI_MODEL,
    input: input as never,
    tools: (tools ?? undefined) as never,
    // Do not retain responses server-side; this is a stateless sales agent.
    store: false,
    max_output_tokens: config.LLM_MAX_OUTPUT_TOKENS,
    reasoning: { effort: config.LLM_REASONING_EFFORT },
    // Stable key so repeated prefixes (the long Arabic developer prompt) hit the
    // provider's prompt cache instead of being re-billed at full price.
    prompt_cache_key: 'ai-commerce-agent',
    // temperature is deliberately omitted: gpt-5-family reasoning models reject
    // or ignore it, and the reasoning effort knob is the supported control.
  };
}

function requestOptions(opts?: LlmCallOptions): { signal: AbortSignal } | undefined {
  return opts?.signal ? { signal: opts.signal } : undefined;
}

async function openaiResponses(
  input: unknown[],
  tools: ChatToolDef[] | undefined,
  opts?: LlmCallOptions,
): Promise<LlmResult> {
  const res = await openai!.responses.create(openaiRequest(input, tools), requestOptions(opts));
  return { output_text: res.output_text, output: res.output as unknown[] };
}

/**
 * Streaming OpenAI variant. Text deltas are forwarded as they arrive, and the
 * full response (including any function calls) is assembled from the terminal
 * `response.completed` event, so the tool loop sees exactly what it would have
 * non-streamed.
 */
async function openaiResponsesStream(
  input: unknown[],
  tools: ChatToolDef[] | undefined,
  opts: LlmCallOptions | undefined,
  onDelta: DeltaHandler,
): Promise<LlmResult> {
  const events = await openai!.responses.create(
    { ...openaiRequest(input, tools), stream: true },
    requestOptions(opts),
  );
  let final: OpenAI.Responses.Response | undefined;
  for await (const event of events) {
    if (event.type === 'response.output_text.delta') {
      if (event.delta) onDelta(event.delta);
    } else if (event.type === 'response.completed') {
      final = event.response;
    }
  }
  if (!final) throw new Error('llm_stream_incomplete');
  return { output_text: final.output_text, output: final.output as unknown[] };
}

async function openrouterChat(
  input: unknown[],
  tools: ChatToolDef[] | undefined,
  opts?: LlmCallOptions,
): Promise<LlmResult> {
  const res = await openrouter!.chat.completions.create(
    {
      model: config.OPENROUTER_MODEL,
      messages: toChatMessages(input) as never,
      tools: toChatTools(tools) as never,
      max_tokens: config.LLM_MAX_OUTPUT_TOKENS,
    },
    opts?.signal ? { signal: opts.signal } : undefined,
  );
  const msg = res.choices[0]?.message;
  const toolCalls = (msg.tool_calls ?? []) as unknown as Array<{
    id: string;
    function?: { name?: string; arguments?: string };
  }>;
  const output: unknown[] = toolCalls.map((tc) => ({
    type: 'function_call',
    call_id: tc.id,
    name: tc.function?.name,
    arguments: tc.function?.arguments ?? '{}',
  }));
  return { output_text: msg.content ?? undefined, output };
}

/**
 * Streaming OpenRouter variant. Chat-completions streams tool calls as deltas
 * keyed by index, so they are accumulated here and only returned once the stream
 * ends — a partially assembled tool call is not valid input for the next round.
 */
async function openrouterChatStream(
  input: unknown[],
  tools: ChatToolDef[] | undefined,
  opts: LlmCallOptions | undefined,
  onDelta: DeltaHandler,
): Promise<LlmResult> {
  const stream = await openrouter!.chat.completions.create(
    {
      model: config.OPENROUTER_MODEL,
      messages: toChatMessages(input) as never,
      tools: toChatTools(tools) as never,
      max_tokens: config.LLM_MAX_OUTPUT_TOKENS,
      stream: true,
    },
    requestOptions(opts),
  );
  let text = '';
  const calls = new Map<number, { id: string; name: string; args: string }>();
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) {
      text += delta.content;
      onDelta(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(idx, cur);
    }
  }
  const output: unknown[] = [...calls.values()].map((c) => ({
    type: 'function_call',
    call_id: c.id,
    name: c.name,
    arguments: c.args || '{}',
  }));
  return { output_text: text || undefined, output };
}

/**
 * A dead provider is worth one fallback; a rejected request is not. Errors that
 * carry an HTTP status fall back only on 408/409/429/5xx — a 400/401/403 means the
 * request itself is wrong and would fail identically on the other provider.
 * Errors without a status are connection/timeout failures, which are retryable.
 */
export function isRetryable(err: unknown): boolean {
  const status =
    (err as { status?: number } | null)?.status ??
    (err as { statusCode?: number } | null)?.statusCode;
  if (typeof status === 'number') {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return true;
}

// Try OpenAI first; on a retryable failure fall back to OpenRouter. Throws when
// neither provider is available, the deadline was aborted, or the error is not
// worth retrying.
export async function chatWithFallback(
  input: unknown[],
  tools?: ChatToolDef[],
  opts?: LlmCallOptions,
): Promise<LlmResult> {
  if (openai) {
    try {
      return await openaiResponses(input, tools, opts);
    } catch (err) {
      // Once the wall-clock deadline has fired, the fallback would abort too.
      if (opts?.signal?.aborted) throw err;
      if (!openrouter || !isRetryable(err)) throw err;
    }
  }
  if (openrouter) return openrouterChat(input, tools, opts);
  throw new Error('no_llm_provider');
}

/**
 * Streaming sibling of `chatWithFallback`.
 *
 * Falling back after the first delta would duplicate text the shopper has already
 * seen, so the other provider is only tried while nothing has been emitted yet.
 */
export async function chatWithFallbackStream(
  input: unknown[],
  tools: ChatToolDef[] | undefined,
  opts: LlmCallOptions | undefined,
  onDelta: DeltaHandler,
): Promise<LlmResult> {
  let emitted = false;
  const wrapped: DeltaHandler = (delta) => {
    emitted = true;
    onDelta(delta);
  };
  if (openai) {
    try {
      return await openaiResponsesStream(input, tools, opts, wrapped);
    } catch (err) {
      if (opts?.signal?.aborted || emitted) throw err;
      if (!openrouter || !isRetryable(err)) throw err;
    }
  }
  if (openrouter) return openrouterChatStream(input, tools, opts, onDelta);
  throw new Error('no_llm_provider');
}