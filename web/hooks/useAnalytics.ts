'use client';

import { useQuery } from '@tanstack/react-query';
import { api, isPaymentRequired } from '@/lib/api';

export function useAttributions(storeId: string | null) {
  return useQuery({
    queryKey: ['attributions', storeId] as const,
    queryFn: () => api.attributions(storeId!),
    enabled: !!storeId,
    staleTime: 30_000,
    retry: (failureCount, error) => !isPaymentRequired(error) && failureCount < 2,
  });
}

export function useSources(storeId: string | null) {
  return useQuery({
    queryKey: ['sources', storeId] as const,
    queryFn: () => api.sources(storeId!),
    enabled: !!storeId,
    staleTime: 30_000,
    retry: (failureCount, error) => !isPaymentRequired(error) && failureCount < 2,
  });
}

export function useTopProducts(storeId: string | null, limit = 10) {
  return useQuery({
    queryKey: ['top-products', storeId, limit] as const,
    queryFn: () => api.topProducts(storeId!, limit),
    enabled: !!storeId,
    staleTime: 30_000,
    retry: (failureCount, error) => !isPaymentRequired(error) && failureCount < 2,
  });
}

export function useConversionLag(storeId: string | null, days = 14) {
  return useQuery({
    queryKey: ['conversion-lag', storeId, days] as const,
    queryFn: () => api.conversionLag(storeId!, days),
    enabled: !!storeId,
    staleTime: 30_000,
    retry: (failureCount, error) => !isPaymentRequired(error) && failureCount < 2,
  });
}