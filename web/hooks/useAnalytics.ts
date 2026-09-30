'use client';

import { useQuery } from '@tanstack/react-query';
import { api, isPaymentRequired } from '@/lib/api';

export function useAttributions(storeId: string | null, status?: 'recommended' | 'clicked' | 'converted') {
  return useQuery({
    // `status` is in the key so switching a filter actually refetches. Without it the
    // cached unfiltered list is served and the filter buttons do nothing visible.
    queryKey: ['attributions', storeId, status ?? 'all'] as const,
    queryFn: () => api.attributions(storeId!, status),
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