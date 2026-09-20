'use client';

import { useState } from 'react';
import { Plus, Workflow } from 'lucide-react';
import { useSelectedStore } from '@/hooks/useStores';
import { useBillingStatus } from '@/hooks/useBilling';
import { useAutomationRules } from '@/hooks/useAutomation';
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
import type { AutomationRule } from '@/lib/types';

const TRIGGER_OPTIONS = [
  { value: 'clicked_no_conversion', label: 'Clicked but no conversion' },
  { value: 'inactive_conversation', label: 'Inactive conversation' },
];

interface DraftRule {
  triggerType: AutomationRule['triggerType'];
  message: string;
  cooldownMinutes: string;
  lookbackHours: string;
}

const emptyDraft: DraftRule = {
  triggerType: 'clicked_no_conversion',
  message:
    'Hi {customerName} 👋 I noticed you liked {productTitle} — want me to help you order it?',
  cooldownMinutes: '1440',
  lookbackHours: '72',
};

export default function AutomationPage() {
  const { storeId } = useSelectedStore();
  const billing = useBillingStatus(storeId);
  const { query, toggle, create, remove } = useAutomationRules(storeId);

  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState<DraftRule>(emptyDraft);
  const [toDelete, setToDelete] = useState<AutomationRule | null>(null);

  const locked = !!billing.data && !['trial', 'active'].includes(billing.data.planStatus);

  const rules = query.data?.rules ?? [];

  const submit = async () => {
    if (!storeId) return;
    if (!draft.message.trim()) {
      return;
    }
    await create.mutateAsync({
      storeId,
      triggerType: draft.triggerType,
      action: { type: 'whatsapp_text', text: draft.message.trim() },
      cooldownMinutes: Math.max(1, Number(draft.cooldownMinutes) || 1440),
      lookbackHours: Math.max(1, Number(draft.lookbackHours) || 72),
    });
    setShowCreate(false);
    setDraft(emptyDraft);
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
            description="Create follow-up nudges for customers who clicked but didn’t convert, or conversations that went cold."
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
        description="When the trigger matches, the WhatsApp template is sent to the customer."
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={submit} loading={create.isPending}>
              Create rule
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <Select
            label="Trigger"
            options={TRIGGER_OPTIONS}
            value={draft.triggerType}
            onChange={(e) =>
              setDraft((d) => ({ ...d, triggerType: e.target.value as AutomationRule['triggerType'] }))
            }
          />

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
              {['{customerName}', '{productTitle}', '{productLink}', '{shopName}'].map((v) => (
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

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Cooldown (minutes)"
              type="number"
              min={1}
              max={43200}
              value={draft.cooldownMinutes}
              onChange={(e) => setDraft((d) => ({ ...d, cooldownMinutes: e.target.value }))}
            />
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
            <b>Cooldown</b>: minimum time between nudges for the same customer.{' '}
            <b>Lookback</b>: how far back the engine scans for matching triggers.
          </p>
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
