'use client';

import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';

export function useBillingStatus(storeId: string | null) {
  return useQuery({
    queryKey: ['billing-status', storeId] as const,
    queryFn: () => api.billingStatus(storeId!),
    enabled: !!storeId,
    staleTime: 120_000,
  });
}

export function useCheckout() {
  return useMutation({
    mutationFn: ({ storeId, plan }: { storeId: string; plan: 'pro' | 'enterprise' }) =>
      api.billingCheckout(storeId, plan),
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Could not start checkout');
    },
  });
}

export function useBillingPortal() {
  return useMutation({
    mutationFn: (storeId: string) => api.billingPortal(storeId),
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Could not open billing portal');
    },
  });
}