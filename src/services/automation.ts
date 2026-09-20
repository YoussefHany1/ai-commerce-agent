import { sql } from 'drizzle-orm';
import { withTenant } from '../db/client.js';
import { automationRepo, conversationRepo, storeRepo, whatsappRepo } from '../db/repos.js';
import type { AutomationRule, AutomationAction } from '../db/schema.js';
import { sendText } from '../integrations/whatsapp.js';

export const TRIGGER_TYPES = ['clicked_no_conversion', 'inactive_conversation'] as const;
export const MAX_ACTIONS = 50;

type Candidate = {
  conversationId: string;
  channel: string;
  phone: string;
  customerName?: string | null;
  productTitle?: string | null;
  productLink?: string | null;
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

  return [];
}

export async function executeRule(storeId: string, rule: AutomationRule): Promise<{ sent: number; failed: number }> {
  const candidates = await candidatesFor(storeId, rule);
  if (!candidates.length) return { sent: 0, failed: 0 };

  const store = await storeRepo.get(storeId);
  const shopName = store?.name ?? null;
  const waChannel = await whatsappRepo.byStore(storeId);
  const template = String((rule.action as AutomationAction).text ?? '');
  let sent = 0;
  let failed = 0;
  let fired = false;

  for (const cand of candidates) {
    const body = renderTemplate(template, {
      customerName: cand.customerName,
      shopName,
      productTitle: cand.productTitle,
      productLink: cand.productLink,
    });

    const logId = await automationRepo.claim(storeId, rule.id, rule.triggerType, cand.conversationId, cand.channel);
    if (!logId) continue;
    fired = true;

    if (cand.channel === 'whatsapp' && waChannel) {
      const ok = await sendText(cand.phone, body, waChannel);
      if (ok) {
        await automationRepo.complete(storeId, logId, 'sent', body, null);
        sent++;
      } else {
        await automationRepo.complete(storeId, logId, 'failed', null, 'send_failed');
        failed++;
      }
    } else {
      await conversationRepo.addMessage({ storeId, conversationId: cand.conversationId, role: 'assistant', content: body });
      await automationRepo.complete(storeId, logId, 'sent', body, null);
      sent++;
    }
  }

  if (fired) await automationRepo.markFired(storeId, rule.id);
  return { sent, failed };
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
