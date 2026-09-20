'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { AutomationRule } from '@/lib/types';

export const automationKey = (storeId: string | null) => ['automation-rules', storeId] as const;

export function useAutomationRules(storeId: string | null) {
  const queryClient = useQueryClient();

  return {
    query: useQuery({
      queryKey: automationKey(storeId),
      queryFn: () => api.automationRules(storeId!),
      enabled: !!storeId,
      staleTime: 30_000,
    }),

    toggle: useMutation({
      mutationFn: ({ rule, enabled }: { rule: AutomationRule; enabled: boolean }) =>
        api.updateAutomationRule(rule.id, { storeId: rule.storeId, enabled }),
      onMutate: async ({ rule, enabled }) => {
        const key = automationKey(rule.storeId);
        await queryClient.cancelQueries({ queryKey: key });
        const previous = queryClient.getQueryData(key);
        queryClient.setQueryData(key, (old: { rules: AutomationRule[] } | undefined) => {
          if (!old) return old;
          return {
            ...old,
            rules: old.rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r)),
          };
        });
        toast.success(enabled ? 'Rule enabled' : 'Rule disabled');
        return { previous, key };
      },
      onError: (_err, _vars, context) => {
        if (context?.previous) {
          queryClient.setQueryData(context.key, context.previous);
        }
        toast.error('Could not update rule');
      },
      onSettled: (_data, _error, vars) => {
        queryClient.invalidateQueries({ queryKey: automationKey(vars.rule.storeId) });
      },
    }),

    create: useMutation({
      mutationFn: api.createAutomationRule,
      onSuccess: (_data, vars) => {
        queryClient.invalidateQueries({ queryKey: automationKey(vars.storeId) });
        toast.success('Rule created');
      },
      onError: (err: unknown) =>
        toast.error(err instanceof Error ? err.message : 'Failed to create rule'),
    }),

    remove: useMutation({
      mutationFn: ({ ruleId, storeId }: { ruleId: string; storeId: string }) =>
        api.deleteAutomationRule(ruleId, storeId),
      onSuccess: (_data, vars) => {
        queryClient.invalidateQueries({ queryKey: automationKey(vars.storeId) });
        toast.success('Rule deleted');
      },
      onError: (err: unknown) =>
        toast.error(err instanceof Error ? err.message : 'Failed to delete rule'),
    }),
  };
}