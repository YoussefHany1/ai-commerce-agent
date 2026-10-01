import { sql } from 'drizzle-orm';
import { withTenant } from '../db/client.js';
import { automationRepo, conversationRepo, storeRepo, whatsappRepo } from '../db/repos.js';
import type { AutomationRule } from '../db/schema.js';
import { sendText } from '../integrations/whatsapp.js';
import { sendOverBaileys } from './whatsappInbound.js';

export const TRIGGER_TYPES = [
  'clicked_no_conversion',
  'inactive_conversation',
  'keyword',
  'new_conversation',
  'order_placed',
] as const;
export const MAX_ACTIONS = 50;

type Candidate = {
  conversationId: string;
  channel: string;
  phone: string;
  customerName?: string | null;
  productTitle?: string | null;
  productLink?: string | null;
  orderTotal?: number | null;
  orderCurrency?: string | null;
};

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = data[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

export function isInCooldown(rule: AutomationRule, now = new Date()): boolean {
  if (!rule.lastFiredAt) return false;
  const minutes = (now.getTime() - new Date(rule.lastFiredAt).getTime()) / 60_000;
  return minutes < rule.cooldownMinutes;
}

/**
 * Whether an inbound message trips a keyword rule.
 *
 * Case-insensitive substring match, not whole-word: merchants write "price" and expect
 * "what's the price?" to fire. An empty keyword is ignored rather than matching every
 * message — a blank row in the builder must not turn the rule into "fire on everything".
 */
export function matchesKeyword(text: string, keywords: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return keywords.some((k) => {
    const needle = k.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

export function keywordsFor(rule: AutomationRule): string[] {
  const raw = rule.triggerConfig?.keywords;
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === 'string' && k.trim().length > 0);
}

async function candidatesFor(storeId: string, rule: AutomationRule): Promise<Candidate[]> {
  if (rule.triggerType === 'clicked_no_conversion') {
    return withTenant(storeId, async (tx) => {
      const rows = (await tx.execute(sql`
        select c.id as conversation_id, c.channel as channel, cust.phone as phone,
               cust.name as customer_name, p.title as product_title, p.url as product_link
        from attributions a
        join conversations c on c.id = a.conversation_id
        join customers cust on cust.id = c.customer_id
        join products p on p.store_id = ${storeId}
          and (p.platform_product_id = a.product_id or p.id::text = a.product_id)
        where a.store_id = ${storeId}
          and a."clickedAt" is not null and a.converted_at is null
          and a."clickedAt" >= now() - make_interval(hours => ${rule.lookbackHours})
          and c.channel = 'whatsapp' and cust.phone is not null
        order by a."clickedAt" desc
        limit ${MAX_ACTIONS}
      `)) as any[];
      return rows.map((r) => ({
        conversationId: String(r.conversation_id),
        channel: String(r.channel),
        phone: String(r.phone),
        customerName: r.customer_name ?? null,
        productTitle: r.product_title ?? null,
        productLink: r.product_link ?? null,
      }));
    });
  }

  if (rule.triggerType === 'inactive_conversation') {
    return withTenant(storeId, async (tx) => {
      const rows = (await tx.execute(sql`
        select c.id as conversation_id, c.channel as channel, cust.phone as phone, cust.name as customer_name
        from conversations c
        join customers cust on cust.id = c.customer_id
        where c.store_id = ${storeId} and c.channel = 'whatsapp' and c.status = 'open' and cust.phone is not null
          and (
            select m.role from messages m where m.conversation_id = c.id order by m."createdAt" desc limit 1
          ) = 'assistant'
          and (
            select max(m."createdAt") from messages m where m.conversation_id = c.id
          ) < now() - make_interval(hours => ${rule.lookbackHours})
        limit ${MAX_ACTIONS}
      `)) as any[];
      return rows.map((r) => ({
        conversationId: String(r.conversation_id),
        channel: String(r.channel),
        phone: String(r.phone),
        customerName: r.customer_name ?? null,
        productTitle: null,
        productLink: null,
      }));
    });
  }

  if (rule.triggerType === 'new_conversation') {
    return withTenant(storeId, async (tx) => {
      const rows = (await tx.execute(sql`
        select c.id as conversation_id, c.channel as channel, cust.phone as phone, cust.name as customer_name
        from conversations c
        join customers cust on cust.id = c.customer_id
        where c.store_id = ${storeId} and c.channel = 'whatsapp' and cust.phone is not null
          and c."createdAt" >= now() - make_interval(hours => ${rule.lookbackHours})
        order by c."createdAt" desc
        limit ${MAX_ACTIONS}
      `)) as any[];
      return rows.map((r) => ({
        conversationId: String(r.conversation_id),
        channel: String(r.channel),
        phone: String(r.phone),
        customerName: r.customer_name ?? null,
        productTitle: null,
        productLink: null,
      }));
    });
  }

  if (rule.triggerType === 'order_placed') {
    return withTenant(storeId, async (tx) => {
      const rows = (await tx.execute(sql`
        select distinct on (o.id)
               c.id as conversation_id, c.channel as channel, cust.phone as phone, cust.name as customer_name,
               o.total as order_total, o.currency as order_currency
        from orders o
        join customers cust on cust.id = o.customer_id
        join conversations c on c.customer_id = o.customer_id and c.store_id = o.store_id and c.channel = 'whatsapp'
        where o.store_id = ${storeId} and cust.phone is not null
          and coalesce(o.placed_at, o."createdAt") >= now() - make_interval(hours => ${rule.lookbackHours})
        order by o.id, c."createdAt" desc
        limit ${MAX_ACTIONS}
      `)) as any[];
      return rows.map((r) => ({
        conversationId: String(r.conversation_id),
        channel: String(r.channel),
        phone: String(r.phone),
        customerName: r.customer_name ?? null,
        productTitle: null,
        productLink: null,
        orderTotal: r.order_total === null || r.order_total === undefined ? null : Number(r.order_total),
        orderCurrency: r.order_currency ?? null,
      }));
    });
  }

  return [];
}

/**
 * Delivers one rendered message to a candidate's own conversation.
 *
 * Meta first (the official transport), then the live Baileys socket. Without the
 * Baileys leg a QR-paired store — which has no `whatsapp_channels` row at all — would
 * have its automation replies silently written into the conversation and never sent,
 * so the customer would never see them.
 */
async function deliverToCandidate(
  storeId: string,
  cand: Candidate,
  body: string,
  waChannel: Awaited<ReturnType<typeof whatsappRepo.byStore>>,
): Promise<boolean> {
  if (cand.channel !== 'whatsapp') {
    await conversationRepo.addMessage({ storeId, conversationId: cand.conversationId, role: 'assistant', content: body });
    return true;
  }
  if (waChannel && (await sendText(cand.phone, body, waChannel))) return true;
  return sendOverBaileys(storeId, cand.phone, body);
}

/** Same transports as `deliverToCandidate`, but to a fixed number rather than a candidate. */
async function deliverToNumber(
  storeId: string,
  phone: string,
  body: string,
  waChannel: Awaited<ReturnType<typeof whatsappRepo.byStore>>,
): Promise<boolean> {
  if (waChannel && (await sendText(phone, body, waChannel))) return true;
  return sendOverBaileys(storeId, phone, body);
}

export async function executeRule(storeId: string, rule: AutomationRule): Promise<{ sent: number; failed: number }> {
  const candidates = await candidatesFor(storeId, rule);
  if (!candidates.length) return { sent: 0, failed: 0 };

  const store = await storeRepo.get(storeId);
  const shopName = store?.name ?? null;
  const waChannel = await whatsappRepo.byStore(storeId);
  const action = rule.action;
  let fired = false;

  // A fixed-recipient action fires once per evaluation, not once per candidate: the
  // trigger only decides *whether* it is time, and the recipient is the merchant, not
  // the shopper. Sending per candidate would message the same number N times.
  if (action.type === 'whatsapp_number') {
    const cand = candidates[0];
    const body = renderTemplate(action.text, { shopName });
    const logId = await automationRepo.claim(storeId, rule.id, rule.triggerType, cand.conversationId, 'whatsapp', {
      scope: 'conversation',
      key: cand.conversationId,
    });
    if (!logId) return { sent: 0, failed: 0 };
    const ok = await deliverToNumber(storeId, action.phone, body, waChannel);
    await automationRepo.complete(storeId, logId, ok ? 'sent' : 'failed', ok ? body : null, ok ? null : 'send_failed');
    await automationRepo.markFired(storeId, rule.id);
    return ok ? { sent: 1, failed: 0 } : { sent: 0, failed: 1 };
  }

  let sent = 0;
  let failed = 0;

  for (const cand of candidates) {
    const body = renderTemplate(action.text, {
      customerName: cand.customerName,
      shopName,
      productTitle: cand.productTitle,
      productLink: cand.productLink,
      orderTotal: cand.orderTotal,
      orderCurrency: cand.orderCurrency,
    });

    const logId = await automationRepo.claim(storeId, rule.id, rule.triggerType, cand.conversationId, cand.channel, {
      scope: 'conversation',
      key: cand.conversationId,
    });
    if (!logId) continue;
    fired = true;

    const ok = await deliverToCandidate(storeId, cand, body, waChannel);
    if (ok) {
      await automationRepo.complete(storeId, logId, 'sent', body, null);
      sent++;
    } else {
      await automationRepo.complete(storeId, logId, 'failed', null, 'send_failed');
      failed++;
    }
  }

  if (fired) await automationRepo.markFired(storeId, rule.id);
  return { sent, failed };
}

export type KeywordMatch = { ruleId: string; body: string };

/**
 * Fires keyword rules synchronously, at the moment a message arrives.
 *
 * This cannot be a poll. `handleInboundText` stores the customer message, then the AI
 * reply, then this is called — so by the time a 30s worker looked, the conversation's
 * *last* message was always the assistant's and the customer's keyword was already
 * buried. A keyword trigger evaluated on a poll therefore never matched, which is
 * exactly what it looked like from the dashboard: the rule existed, was enabled, and
 * never fired.
 *
 * Cooldown is deliberately not applied here. Cooldown is per rule, not per customer, so
 * honouring it would mean one keyword reply per store per cooldown window — the second
 * customer to say "price" would get silence. Per-customer repetition is bounded by the
 * `automation_logs` claim instead: one send per rule per conversation.
 *
 * @returns the first rule that claimed and delivered, or `null` if none matched.
 */
export async function runKeywordAutomation(
  storeId: string,
  input: { conversationId: string; messageId?: string | null; phone: string; customerName?: string | null; text: string },
): Promise<KeywordMatch | null> {
  const rules = await automationRepo.listEnabledByTrigger(storeId, 'keyword');
  if (!rules.length) return null;

  const waChannel = await whatsappRepo.byStore(storeId);
  const store = await storeRepo.get(storeId);
  const shopName = store?.name ?? null;

  for (const rule of rules) {
    if (!matchesKeyword(input.text, keywordsFor(rule))) continue;

    // The candidate shape is fixed by the shared claim/log path; the phone and
    // conversation come from the inbound message rather than a query.
    const cand: Candidate = {
      conversationId: input.conversationId,
      channel: 'whatsapp',
      phone: input.phone,
      customerName: input.customerName ?? null,
      productTitle: null,
      productLink: null,
    };

    const body = renderTemplate(rule.action.text, { customerName: cand.customerName, shopName });
    // Dedupe on the inbound message, not the conversation. Keying on the conversation made
    // a keyword rule answer each customer exactly once for the lifetime of the
    // conversation, so a repeat keyword fell through to the AI with no log at all.
    const logId = await automationRepo.claim(storeId, rule.id, rule.triggerType, cand.conversationId, 'whatsapp', {
      scope: 'message',
      key: input.messageId ?? `${cand.conversationId}:${crypto.randomUUID()}`,
    });
    if (!logId) continue;

    const ok = await deliverToCandidate(storeId, cand, body, waChannel);
    await automationRepo.complete(storeId, logId, ok ? 'sent' : 'failed', ok ? body : null, ok ? null : 'send_failed');
    if (ok) await automationRepo.markFired(storeId, rule.id);
    return ok ? { ruleId: rule.id, body } : null;
  }

  return null;
}

export type AutomationSummary = {
  rulesEvaluated: number;
  actionsSent: number;
  actionsFailed: number;
  rulesSkipped: number;
};

export async function runAllAutomation(opts?: {
  storeIds?: string[];
  ruleIds?: string[];
  ignoreCooldown?: boolean;
}): Promise<AutomationSummary> {
  const all = await automationRepo.listEnabled();
  let summary: AutomationSummary = { rulesEvaluated: 0, actionsSent: 0, actionsFailed: 0, rulesSkipped: 0 };
  for (const rule of all) {
    // Keyword rules are driven from the inbound path, not from here. Evaluating them
    // on a poll is not merely wasteful — by the time this runs the AI reply is the
    // conversation's last message, so the keyword can never match. Counting them as
    // skipped keeps them visible in the tick summary instead of silently looking idle.
    if (rule.triggerType === 'keyword') {
      summary.rulesSkipped++;
      continue;
    }
    if (opts?.ruleIds && !opts.ruleIds.includes(rule.id)) continue;
    if (opts?.storeIds && !opts.storeIds.includes(rule.storeId)) continue;
    if (!opts?.ignoreCooldown && isInCooldown(rule)) {
      summary.rulesSkipped++;
      continue;
    }
    summary.rulesEvaluated++;
    const { sent, failed } = await executeRule(rule.storeId, rule);
    summary.actionsSent += sent;
    summary.actionsFailed += failed;
  }
  return summary;
}
