import OpenAI from 'openai';
import type { Product } from '../types.js';
import { retrieve } from './retrieval.js';
import { chatWithFallback, chatWithFallbackStream, hasOpenAI, hasOpenRouter } from './llm.js';
import { customerRepo, orderRepo, catalogRepo } from '../db/repos.js';
import { getCommerceAdapter } from '../integrations/factory.js';
import { config } from '../config.js';

type ToolDef = OpenAI.Responses.FunctionTool;
type FunctionCall = OpenAI.Responses.ResponseFunctionToolCall;
import type { CommerceAdapter } from '../types.js';

const MAX_MESSAGE_LENGTH = 4000;
const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_RESULT_LEN = 3000;

function sanitizeUserInput(input: string): string {
  return input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, MAX_MESSAGE_LENGTH);
}

function fallbackReply(products: Product[]): string {
  const list = products.map((p) => `• ${p.title} — ${p.price} ${p.currency}${p.url ? `\n${p.url}` : ''}`).join('\n');
  if (!products.length) return 'حالياً لا أستطيع الاطلاع على المنتجات. يرجى المحاولة لاحقاً.';
  return `مرحباً. هذه المنتجات الأقرب لطلبك:\n${list}`;
}

// Distinct from fallbackReply: when the model burns every tool round without
// settling on an answer, the old reply claimed there were no products visible,
// which is misleading. Ask the shopper for clarification instead.
const TOOL_EXHAUSTED_REPLY = 'لم أتمكن من إكمال طلبك من البيانات المتاحة. هل يمكنك توضيح ما تبحث عنه أكثر؟';

function formatProductContext(products: Product[]): string {
  return products
    .map(
      (p) =>
        `ID:${p.id}\n${p.title}\nالسعر: ${p.price} ${p.currency}\nمتاح: ${p.available ? 'نعم' : 'لا'}\nالرابط: ${p.url ?? ''}\n${p.description ?? ''}`,
    )
    .join('\n---\n');
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export function toChatHistory(rows: ReadonlyArray<{ role: string; content: string }>): ChatMessage[] {
  return rows
    .filter((r): r is ChatMessage => r.role === 'user' || r.role === 'assistant')
    .map((r) => ({ role: r.role, content: r.content }));
}

export const TOOLS: ToolDef[] = [
  {
    type: 'function',
    name: 'search_products',
    description:
      'ابحث في كتالوج المتجر عن منتجات تطابق طلب العميل. استخدمه قبل الإجابة عن أي سؤال عن منتج أو سعر أو توفر. ابحث بالعربية أو بالإنجليزية.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'كلمات البحث، عربية أو إنجليزية' },
        limit: { type: 'number', minimum: 1, maximum: 20, description: 'عدد النتائج (الافتراضي 8)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_products',
    description: 'اعرض المنتجات المتوفرة في المتجر بدون بحث محدد.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_order_status',
    description: 'استعلم عن حالة طلب عميل من المتجر. استخدمه إذا سأل العميل عن حالة طلبه أو رقم تتبع.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        platform_order_id: { type: 'string', description: 'رقم الطلب/المعرف كما يظهر عند العميل أو في المتجر' },
      },
      required: ['platform_order_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_customer',
    description:
      'ابحث عن عميل برقم الجوال أو البريد الإلكتروني لعرض معلوماته وطلباته الأخيرة. استخدمه إذا أعطى العميل رقم جواله أو بريده. لا تشارك معلومات حساسة كاملة مع العميل.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'رقم الجوال أو البريد الإلكتروني للعميل' },
      },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

type ToolArgs = Record<string, unknown>;

function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const t = phone.trim();
  if (t.length < 5) return '****';
  return `${t.slice(0, 2)}****${t.slice(-2)}`;
}

function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at <= 0) return '***@***';
  const local = email.slice(0, Math.min(at, 2));
  return `${local}***${email.slice(at)}`;
}

function clampJson(s: string): string {
  if (s.length <= MAX_TOOL_RESULT_LEN) return s;
  // Never slice JSON mid-object: a cut string is not parseable, so the model sees
  // a syntax error instead of data. Emit a valid marker and let the tool itself
  // bound its result size.
  return JSON.stringify({ truncated: true, reason: `result exceeded ${MAX_TOOL_RESULT_LEN} characters` });
}

/**
 * Serializes products for a tool result. Descriptions and unused fields are
 * dropped so a full page of results stays under the size cap without truncation.
 */
function projectProducts(products: Product[], maxItems: number): string {
  return JSON.stringify(
    products.slice(0, maxItems).map((p) => ({
      id: p.id,
      title: p.title,
      price: p.price,
      currency: p.currency,
      available: p.available,
      url: p.url ?? null,
    })),
  );
}

async function runTool(storeId: string, name: string, args: ToolArgs): Promise<string> {
  switch (name) {
    case 'search_products': {
      const query = String(args.query ?? '').trim();
      if (!query) return JSON.stringify({ error: 'query_required' });
      const limit = Math.min(Number(args.limit) || 8, 20);
      const found = await retrieve(query, storeId, { limit });
      return projectProducts(found.map((f) => f.product), limit);
    }
    case 'list_products': {
      const limit = Math.min(Number(args.limit) || 20, 50);
      const products = await catalogRepo.list(storeId, limit);
      return projectProducts(products, limit);
    }
    case 'get_order_status': {
      const platformOrderId = String(args.platform_order_id ?? '').trim();
      if (!platformOrderId) return JSON.stringify({ error: 'order_id_required' });
      const order = await orderRepo.byPlatformId(storeId, platformOrderId);
      if (!order) return JSON.stringify({ error: 'order_not_found' });
      const adapter = await getCommerceAdapter(storeId);
      let live: Awaited<ReturnType<CommerceAdapter['getOrder']>> | null = null;
      if (adapter) {
        try {
          live = await adapter.getOrder(platformOrderId);
        } catch {
          live = null;
        }
      }
      const best = live ?? order;
      return clampJson(
        JSON.stringify({
          id: best.id,
          status: best.status,
          paymentStatus: best.paymentStatus ?? null,
          total: best.total,
          currency: best.currency,
          source: live ? 'live' : 'local',
        }),
      );
    }
    case 'get_customer': {
      const identifier = String(args.identifier ?? '').trim();
      if (!identifier) return JSON.stringify({ error: 'identifier_required' });
      const matches = await customerRepo.findByContact(storeId, identifier);
      if (!matches.length) return JSON.stringify({ error: 'customer_not_found' });
      const customers = await Promise.all(
        matches.map(async (c) => {
          const orders = await orderRepo.listByCustomer(storeId, c.id, 5);
          return {
            id: c.id,
            name: c.name ?? null,
            phone: maskPhone(c.phone),
            email: maskEmail(c.email),
            recentOrders: orders.map((o) => ({
              id: o.id,
              status: o.status,
              paymentStatus: o.paymentStatus ?? null,
              total: o.total,
              currency: o.currency,
            })),
          };
        }),
      );
      return clampJson(JSON.stringify(customers));
    }
    default:
      return JSON.stringify({ error: 'unknown_tool' });
  }
}

type ToolRun = {
  name: string;
  args: ToolArgs;
  output: string;
};

export async function runToolLoop(
  storeId: string,
  message: string,
  create: (input: unknown[]) => Promise<{ output_text?: string; output?: unknown[] }>,
  history: ChatMessage[] = [],
): Promise<{ reply: string; toolRuns: ToolRun[] }> {
  const cleaned = sanitizeUserInput(message);
  const input: unknown[] = [
    {
      role: 'developer',
      content:
        'أنت موظف مبيعات إلكتروني لمتجر سعودي. أجب بالعربية السعودية باختصار ووضوح. استخدم الأدوات للبحث عن المنتجات والطلبات والعملاء — لا تخترع أسعاراً أو مخزوناً أو حالات طلبات أبداً. إذا لم تجد إجابة، قل إنك تحتاج توضيحاً أو حوّل العميل لموظف. إذا طلب العميل معلومات حساسة (جوال/بريد) لا تكررها كاملة، اكتفِ بذكر الحالة والأرقام غير حساسة.',
    },
    ...history.map((h) => ({ role: h.role, content: sanitizeUserInput(h.content) })),
    { role: 'user', content: cleaned },
  ];

  const toolRuns: ToolRun[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await create(input);
    const calls = ((res.output ?? []) as unknown[]).filter(
      (o): o is FunctionCall =>
        typeof o === 'object' && o !== null && (o as { type?: string }).type === 'function_call',
    );
    if (!calls.length) {
      return { reply: res.output_text ?? fallbackReply([]), toolRuns };
    }
    // Tool calls in one round are independent, so run them together. Promise.all
    // preserves order, keeping each output lined up with its originating call.
    const outputs = await Promise.all(
      calls.map(async (call) => {
        let args: ToolArgs = {};
        try {
          args = JSON.parse(call.arguments ?? '{}');
        } catch {
          args = { _parse_error: call.arguments };
        }
        if (!TOOL_NAMES.has(call.name)) {
          return { call, args, output: JSON.stringify({ error: 'unknown_tool' }), run: false as const };
        }
        const output = await runTool(storeId, call.name, args);
        return { call, args, output, run: true as const };
      }),
    );
    for (const r of outputs) {
      if (r.run) toolRuns.push({ name: r.call.name, args: r.args, output: r.output });
    }
    input.push(
      ...calls,
      ...outputs.map((r) => ({ type: 'function_call_output', call_id: r.call.call_id, output: r.output })),
    );
  }

  return { reply: TOOL_EXHAUSTED_REPLY, toolRuns };
}

export async function answer(message: string, products: Product[]): Promise<string> {
  const cleaned = sanitizeUserInput(message);
  const context = formatProductContext(products);

  if (!hasOpenAI && !hasOpenRouter) return fallbackReply(products);

  try {
    const r = await chatWithFallback([
      {
        role: 'developer',
        content: `أنت موظف مبيعات لمتجر سعودي. أجب بالعربية السعودية باختصار. لا تخترع سعراً أو مخزوناً أو مواصفة. استخدم المنتجات التالية فقط. إذا لم تجد جواباً قل إنك تحتاج من العميل توضيحاً أو تحويله لموظف.\n\n${context}`,
      },
      { role: 'user', content: cleaned },
    ]);
    return r.output_text ?? fallbackReply(products);
  } catch (err: any) {
    const status = err?.status ?? err?.statusCode;
    if (status === 429 || status === 500 || status === 502 || status === 503) {
      return fallbackReply(products);
    }
    throw err;
  }
}

export async function answerWithTools(
  storeId: string,
  message: string,
  history: ChatMessage[] = [],
): Promise<string> {
  if (!hasOpenAI && !hasOpenRouter) {
    const found = await retrieve(message, storeId, { limit: 8 });
    return fallbackReply(found.map((f) => f.product));
  }
  // Wall-clock deadline for the whole tool loop. Without it, three slow rounds
  // each retried by the SDK could hold the request open for minutes.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), config.LLM_TOTAL_TIMEOUT_MS);
  deadline.unref?.();
  try {
    const { reply } = await runToolLoop(
      storeId,
      message,
      (input) => chatWithFallback(input as any, TOOLS, { signal: controller.signal }),
      history,
    );
    return reply;
  } catch {
    const found = await retrieve(message, storeId, { limit: 8 });
    return fallbackReply(found.map((f) => f.product));
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Streaming sibling of `answerWithTools`. Text is forwarded as the model
 * produces it, while the tool loop and persistence are otherwise identical.
 *
 * `signal` lets a caller (the chat route) stop generation as soon as the shopper
 * disconnects; it is folded into the same controller as the wall-clock deadline.
 */
export async function answerWithToolsStream(
  storeId: string,
  message: string,
  history: ChatMessage[] = [],
  onDelta: (delta: string) => void = () => {},
  signal?: AbortSignal,
): Promise<string> {
  if (!hasOpenAI && !hasOpenRouter) {
    const found = await retrieve(message, storeId, { limit: 8 });
    const reply = fallbackReply(found.map((f) => f.product));
    onDelta(reply);
    return reply;
  }
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const deadline = setTimeout(() => controller.abort(), config.LLM_TOTAL_TIMEOUT_MS);
  deadline.unref?.();
  let emitted = false;
  const emit = (delta: string) => {
    if (!delta) return;
    emitted = true;
    onDelta(delta);
  };
  try {
    const { reply } = await runToolLoop(
      storeId,
      message,
      (input) => chatWithFallbackStream(input as any, TOOLS, { signal: controller.signal }, emit),
      history,
    );
    return reply;
  } catch (err) {
    // Once any text has streamed, a fallback would append a second answer to the
    // first; surface the failure instead and let the caller keep what it has.
    if (emitted) throw err;
    const found = await retrieve(message, storeId, { limit: 8 });
    const reply = fallbackReply(found.map((f) => f.product));
    emit(reply);
    return reply;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}