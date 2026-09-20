'use client';

import { useQuery } from '@tanstack/react-query';
import { api, isPaymentRequired } from '@/lib/api';

export function useMetrics(storeId: string | null, days = 14) {
  return useQuery({
    queryKey: ['metrics', storeId, days] as const,
    queryFn: () => api.metrics(storeId!, days),
    enabled: !!storeId,
    staleTime: 30_000,
    retry: (failureCount, error) => !isPaymentRequired(error) && failureCount < 2,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'] as const,
    queryFn: api.health,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}