import OpenAI from 'openai';
import { config } from '../config.js';

const REQUEST_TIMEOUT_MS = config.LLM_REQUEST_TIMEOUT_MS;

export type ChatToolDef = OpenAI.Responses.FunctionTool;

export type LlmCallOptions = { signal?: AbortSignal };

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

async function openaiResponses(
  input: unknown[],
  tools: ChatToolDef[] | undefined,
  opts?: LlmCallOptions,
): Promise<LlmResult> {
  const res = await openai!.responses.create(
    {
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
    },
    opts?.signal ? { signal: opts.signal } : undefined,
  );
  return { output_text: res.output_text, output: res.output as unknown[] };
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