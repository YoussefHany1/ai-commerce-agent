'use client';

import { useState } from 'react';
import { Plus, Trash2, Workflow } from 'lucide-react';
import { useSelectedStore } from '@/hooks/useStores';
import { useBillingStatus } from '@/hooks/useBilling';
import { useAutomationRules, useAutomationTemplates } from '@/hooks/useAutomation';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { RuleCard } from '@/components/dashboard/RuleCard';
import { PlanGate } from '@/components/dashboard/PlanGate';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Drawer } from '@/components/ui/Drawer';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import type { AutomationAction, AutomationRule, MessageTemplate } from '@/lib/types';

const TRIGGER_OPTIONS = [
  { value: 'clicked_no_conversion', label: 'Clicked but no conversion' },
  { value: 'inactive_conversation', label: 'Inactive conversation' },
  { value: 'keyword', label: 'Customer sends a keyword' },
  { value: 'new_conversation', label: 'New conversation' },
  { value: 'order_placed', label: 'Order placed' },
];

const ACTION_OPTIONS = [
  { value: 'whatsapp_text', label: 'Reply to the customer who triggered it' },
  { value: 'whatsapp_number', label: 'Send to a specific number' },
  { value: 'template', label: 'Use a saved template' },
];

const TOKENS = ['{customerName}', '{productTitle}', '{productLink}', '{shopName}', '{orderTotal}'];

interface DraftRule {
  triggerType: AutomationRule['triggerType'];
  keywords: string;
  actionType: AutomationAction['type'];
  phone: string;
  templateId: string;
  message: string;
  cooldownMinutes: string;
  lookbackHours: string;
  templateName: string;
}

const emptyDraft: DraftRule = {
  triggerType: 'clicked_no_conversion',
  keywords: '',
  actionType: 'whatsapp_text',
  phone: '',
  templateId: '',
  message:
    'Hi {customerName} 👋 I noticed you liked {productTitle} — want me to help you order it?',
  cooldownMinutes: '1440',
  lookbackHours: '72',
  templateName: '',
};

export default function AutomationPage() {
  const { storeId } = useSelectedStore();
  const billing = useBillingStatus(storeId);
  const { query, toggle, create, remove } = useAutomationRules(storeId);
  const templates = useAutomationTemplates(storeId);

  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState<DraftRule>(emptyDraft);
  const [toDelete, setToDelete] = useState<AutomationRule | null>(null);

  const locked = !!billing.data && !['trial', 'active'].includes(billing.data.planStatus);

  const rules = query.data?.rules ?? [];
  const savedTemplates: MessageTemplate[] = templates.query.data?.templates ?? [];

  const keywordList = draft.keywords
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  // Mirrors EVENT_TRIGGERS in src/services/automation.ts. A cooldown on a discrete event
  // means the first occurrence silences the next one, which is why the engine ignores it.
  const isEventTrigger = draft.triggerType === 'order_placed';

  const missingRequirement = !draft.message.trim()
    ? 'Write the message to send.'
    : draft.triggerType === 'keyword' && keywordList.length === 0
      ? 'Add at least one keyword for this trigger.'
      : draft.actionType === 'whatsapp_number' && !draft.phone.trim()
        ? 'Enter the number to send to.'
        : draft.actionType === 'template' && !draft.templateId
          ? 'Pick a saved template.'
          : null;

  const submit = async () => {
    if (!storeId || missingRequirement) return;
    const text = draft.message.trim();
    const action: AutomationAction =
      draft.actionType === 'whatsapp_number'
        ? { type: 'whatsapp_number', phone: draft.phone.trim(), text }
        : draft.actionType === 'template'
          ? { type: 'template', templateId: draft.templateId, text }
          : { type: 'whatsapp_text', text };

    await create.mutateAsync({
      storeId,
      triggerType: draft.triggerType,
      triggerConfig: draft.triggerType === 'keyword' ? { keywords: keywordList } : {},
      action,
      cooldownMinutes: Math.max(1, Number(draft.cooldownMinutes) || 1440),
      lookbackHours: Math.max(1, Number(draft.lookbackHours) || 72),
    });
    setShowCreate(false);
    setDraft(emptyDraft);
  };

  const saveTemplate = async () => {
    if (!storeId || !draft.message.trim() || !draft.templateName.trim()) return;
    const next: MessageTemplate = {
      id: `tpl_${Date.now().toString(36)}`,
      name: draft.templateName.trim(),
      text: draft.message.trim(),
    };
    const list = [...savedTemplates, next];
    await templates.save.mutateAsync({ storeId, templates: list });
    setDraft((d) => ({ ...d, actionType: 'template', templateId: next.id, templateName: '' }));
  };

  const deleteTemplate = async (tpl: MessageTemplate) => {
    if (!storeId) return;
    await templates.save.mutateAsync({
      storeId,
      templates: savedTemplates.filter((t) => t.id !== tpl.id),
    });
    setDraft((d) => (d.templateId === tpl.id ? { ...d, templateId: '' } : d));
  };

  const content = (
    <div className="space-y-6">
      {query.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : rules.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Workflow className="h-6 w-6" />}
            title="No automation rules yet"
            description="Reply to keywords, welcome new chats, follow up on clicks that didn’t convert, or message a specific number."
            action={
              <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
                Create your first rule
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              disabled={locked}
              toggling={toggle.isPending}
              onToggle={(enabled) => toggle.mutate({ rule, enabled })}
              onDelete={() => setToDelete(rule)}
            />
          ))}
        </div>
      )}

      {query.data && (
        <p className="text-xs text-slate-400">
          The engine evaluates enabled rules every 30 seconds and respects each rule’s cooldown.
        </p>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Automation"
        description="Follow-up rules that bring customers back after a click or a silent chat."
      >
        <Badge variant="violet">Pro feature</Badge>
        <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
          Create rule
        </Button>
      </PageHeader>

      {locked ? (
        <PlanGate
          title="Automation is a Pro feature"
          description="Enable follow-up rules, cooldowns and WhatsApp nudges by upgrading your plan."
        >
          {content}
        </PlanGate>
      ) : (
        content
      )}

      {/* Create rule drawer */}
      <Drawer
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create automation rule"
        description="Choose what starts the rule, then where the message goes."
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={submit} loading={create.isPending} disabled={!!missingRequirement}>
              Create rule
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <Select
            label="When"
            options={TRIGGER_OPTIONS}
            value={draft.triggerType}
            onChange={(e) =>
              setDraft((d) => ({ ...d, triggerType: e.target.value as AutomationRule['triggerType'] }))
            }
          />

          {draft.triggerType === 'keyword' && (
            <Input
              label="Keywords"
              value={draft.keywords}
              onChange={(e) => setDraft((d) => ({ ...d, keywords: e.target.value }))}
              placeholder="price, order, shipping"
            />
          )}
          {draft.triggerType === 'keyword' && (
            <p className="-mt-3 text-xs text-slate-500 dark:text-slate-400">
              Fires when the customer’s last message contains any of these words. Match is
              case-insensitive and anywhere in the message.
            </p>
          )}

          <Select
            label="Action"
            options={ACTION_OPTIONS}
            value={draft.actionType}
            onChange={(e) =>
              setDraft((d) => ({ ...d, actionType: e.target.value as AutomationAction['type'] }))
            }
          />

          {draft.actionType === 'whatsapp_number' && (
            <Input
              label="Send to number"
              value={draft.phone}
              onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
              placeholder="+966501234567"
            />
          )}
          {draft.actionType === 'whatsapp_number' && (
            <p className="-mt-3 text-xs text-slate-500 dark:text-slate-400">
              Sent once when the trigger matches, no matter how many customers match it.
              Customer names and products are not available here.
            </p>
          )}

          {draft.actionType === 'template' && (
            <div className="space-y-1.5">
              <label className="label-muted" htmlFor="rule-template">
                Saved template
              </label>
              <select
                id="rule-template"
                value={draft.templateId}
                onChange={(e) => {
                  const found = savedTemplates.find((t) => t.id === e.target.value);
                  setDraft((d) => ({
                    ...d,
                    templateId: e.target.value,
                    message: found ? found.text : d.message,
                  }));
                }}
                className="input-base"
              >
                <option value="">Choose a template…</option>
                {savedTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {savedTemplates.length === 0 && (
                <p className="text-xs text-slate-400">
                  No saved templates yet. Write the message below and save it as a template.
                </p>
              )}
              {savedTemplates.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {savedTemplates.map((t) => (
                    <span
                      key={t.id}
                      className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300"
                    >
                      {t.name}
                      <button
                        type="button"
                        onClick={() => deleteTemplate(t)}
                        aria-label={`Delete template ${t.name}`}
                        className="text-slate-400 hover:text-red-500"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="label-muted" htmlFor="rule-message">
              WhatsApp message template
            </label>
            <textarea
              id="rule-message"
              value={draft.message}
              onChange={(e) => setDraft((d) => ({ ...d, message: e.target.value }))}
              rows={5}
              className="input-base min-h-[130px] resize-y"
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {TOKENS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() =>
                    setDraft((d) => (d.message.includes(v) ? d : { ...d, message: d.message + ' ' + v }))
                  }
                  className="rounded-full border border-violet-500/25 bg-violet-500/10 px-2.5 py-1 font-mono text-[11px] text-violet-600 transition hover:bg-violet-500/20 dark:text-violet-300"
                >
                  {v}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-400">Insert placeholders for dynamic content.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="New template name"
              value={draft.templateName}
              onChange={(e) => setDraft((d) => ({ ...d, templateName: e.target.value }))}
              placeholder="Price follow-up"
            />
            <div className="flex items-end pb-1">
              <Button
                variant="secondary"
                onClick={saveTemplate}
                loading={templates.save.isPending}
                disabled={!draft.templateName.trim() || !draft.message.trim()}
              >
                Save as template
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {isEventTrigger ? (
              <div className="flex flex-col justify-center rounded-lg border border-dashed border-slate-300 px-3 py-2 dark:border-slate-700">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  Cooldown: not applicable
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Each order is its own event and is sent once.
                </span>
              </div>
            ) : (
              <Input
                label="Cooldown (minutes)"
                type="number"
                min={1}
                max={43200}
                value={draft.cooldownMinutes}
                onChange={(e) => setDraft((d) => ({ ...d, cooldownMinutes: e.target.value }))}
              />
            )}
            <Input
              label="Lookback (hours)"
              type="number"
              min={1}
              max={8760}
              value={draft.lookbackHours}
              onChange={(e) => setDraft((d) => ({ ...d, lookbackHours: e.target.value }))}
            />
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {isEventTrigger ? (
              <>
                <b>Lookback</b>: how far back the engine scans for matching triggers. Every
                matching order is messaged, and an order is never messaged twice.
              </>
            ) : (
              <>
                <b>Cooldown</b>: minimum time between nudges for the same customer.{' '}
                <b>Lookback</b>: how far back the engine scans for matching triggers.
              </>
            )}
          </p>
          {missingRequirement && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{missingRequirement}</p>
          )}
        </div>
      </Drawer>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) {
            remove.mutate({ ruleId: toDelete.id, storeId: toDelete.storeId });
            setToDelete(null);
          }
        }}
        loading={remove.isPending}
        title="Delete automation rule?"
        description="The follow-up nudge will stop immediately. This can’t be undone."
        confirmLabel="Delete rule"
      />
    </div>
  );
}