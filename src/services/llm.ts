import OpenAI from 'openai';
import { config } from '../config.js';

const TIMEOUT_MS = 30_000;

export type ChatToolDef = OpenAI.Responses.FunctionTool;

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
  return new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: TIMEOUT_MS, maxRetries: 2 });
}

function buildOpenRouter(): OpenAI | null {
  if (!config.OPENROUTER_API_KEY) return null;
  return new OpenAI({
    apiKey: config.OPENROUTER_API_KEY,
    baseURL: resolveBaseUrl(),
    timeout: TIMEOUT_MS,
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

async function openaiResponses(input: unknown[], tools?: ChatToolDef[]): Promise<LlmResult> {
  const res = await openai!.responses.create({
    model: config.OPENAI_MODEL,
    input: input as never,
    tools: (tools ?? undefined) as never,
  });
  return { output_text: res.output_text, output: res.output as unknown[] };
}

async function openrouterChat(input: unknown[], tools?: ChatToolDef[]): Promise<LlmResult> {
  const res = await openrouter!.chat.completions.create({
    model: config.OPENROUTER_MODEL,
    messages: toChatMessages(input) as never,
    tools: toChatTools(tools) as never,
  });
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

// Try OpenAI first; on any failure (missing key, 429/5xx, timeout, network) fall
// back to OpenRouter. Throws when neither provider is available or both fail.
export async function chatWithFallback(input: unknown[], tools?: ChatToolDef[]): Promise<LlmResult> {
  if (openai) {
    try {
      return await openaiResponses(input, tools);
    } catch (err) {
      if (!openrouter) throw err;
    }
  }
  if (openrouter) return openrouterChat(input, tools);
  throw new Error('no_llm_provider');
}