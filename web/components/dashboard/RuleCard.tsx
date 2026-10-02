'use client';

import { motion } from 'framer-motion';
import { AlarmClock, Clock, MessageSquareQuote, Trash2, Zap } from 'lucide-react';
import { Toggle } from '@/components/ui/Toggle';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatFromNow } from '@/lib/utils';
import type { AutomationRule } from '@/lib/types';

const TRIGGER_LABEL: Record<AutomationRule['triggerType'], { title: string; description: string }> = {
  clicked_no_conversion: {
    title: 'Clicked but no conversion',
    description: 'Customer clicked a recommended product but hasn’t purchased yet.',
  },
  inactive_conversation: {
    title: 'Inactive conversation',
    description: 'Conversation went idle after the last assistant message.',
  },
  keyword: {
    title: 'Customer sends a keyword',
    description: 'An inbound message contains one of the watched words.',
  },
  new_conversation: {
    title: 'New conversation',
    description: 'A customer starts a fresh chat.',
  },
  order_placed: {
    title: 'Order placed',
    description: 'A new order lands for a customer with a WhatsApp number.',
  },
};

/**
 * What the rule sends and to whom, in the two lines the card shows.
 *
 * `target` is the recipient for the fixed-number action; every other variant replies to
 * whoever tripped the trigger, which is the default and needs no second line.
 */
function actionSummary(action: AutomationRule['action']): { label: string; target?: string } {
  if (action.type === 'whatsapp_number') return { label: 'WhatsApp message to a fixed number', target: action.phone };
  if (action.type === 'template') return { label: 'Saved template message' };
  return { label: 'WhatsApp message' };
}

interface RuleCardProps {
  rule: AutomationRule;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  disabled?: boolean;
  toggling?: boolean;
}

export function RuleCard({ rule, onToggle, onDelete, disabled, toggling }: RuleCardProps) {
  const meta = TRIGGER_LABEL[rule.triggerType] ?? {
    title: rule.triggerType,
    description: 'Custom automation rule',
  };
  const action = actionSummary(rule.action);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="card card-hover relative overflow-hidden p-5"
    >
      <div
        className={
          rule.enabled
            ? 'pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-violet-600 via-violet-400 to-cyan-500'
            : 'pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-slate-200 dark:bg-white/5'
        }
      />

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={
              rule.enabled
                ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-violet-400'
                : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-200 text-slate-400 dark:bg-white/5'
            }
          >
            <Zap
              className={
                rule.enabled
                  ? 'h-5 w-5 text-white'
                  : 'h-5 w-5'
              }
            />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {meta.title}
              </h3>
              <Badge variant={rule.enabled ? 'success' : 'neutral'} dot>
                {rule.enabled ? 'Active' : 'Paused'}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{meta.description}</p>
            {rule.triggerType === 'keyword' && (rule.triggerConfig?.keywords ?? []).length > 0 && (
              <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                Keywords: <span className="font-mono">{(rule.triggerConfig?.keywords ?? []).join(', ')}</span>
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Toggle
            checked={rule.enabled}
            onChange={onToggle}
            disabled={disabled || toggling}
            aria-label="Toggle rule"
            size="sm"
          />
          <Button variant="ghost" size="icon" onClick={onDelete} aria-label="Delete rule" disabled={disabled}>
            <Trash2 className="h-4 w-4 text-slate-400 hover:text-red-500" />
          </Button>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-slate-200/70 bg-slate-50/60 p-3.5 dark:border-white/5 dark:bg-white/[0.02]">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-violet-600 dark:text-violet-300">
          <MessageSquareQuote className="h-3.5 w-3.5" />
          {action.label}
          {action.target && (
            <span className="font-mono normal-case tracking-normal text-slate-500 dark:text-slate-400">
              {' '}
              → {action.target}
            </span>
          )}
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {rule.action.text}
        </p>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-500 dark:text-slate-400">
        <span className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" />
          {rule.triggerType === 'order_placed' ? (
            <>
              Cadence: <b className="font-semibold text-slate-700 dark:text-slate-200">every order</b>
            </>
          ) : (
            <>
              Cooldown:{' '}
              <b className="font-semibold text-slate-700 dark:text-slate-200">
                {rule.cooldownMinutes} min
              </b>
            </>
          )}
        </span>
        <span className="flex items-center gap-1.5">
          <AlarmClock className="h-3.5 w-3.5" />
          Lookback: <b className="font-semibold text-slate-700 dark:text-slate-200">{rule.lookbackHours} h</b>
        </span>
        {rule.lastFiredAt && (
          <span className="ms-auto">Last fired {formatFromNow(rule.lastFiredAt)}</span>
        )}
      </div>
    </motion.div>
  );
}