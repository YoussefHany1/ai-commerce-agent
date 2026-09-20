'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Store } from '@/lib/types';
import { useActiveStore } from '@/lib/store-context';

export const STORES_KEY = ['stores'] as const;

export function useStores() {
  return useQuery({
    queryKey: STORES_KEY,
    queryFn: api.listStores,
    staleTime: 60_000,
  });
}

export function useCreateStore() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createStore,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STORES_KEY });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to create store');
    },
  });
}

/**
 * Resolves the active store: the one selected in the topbar, falling back
 * to the most recent connected store automatically.
 */
export function useSelectedStore() {
  const { activeStoreId, setActiveStoreId } = useActiveStore();
  const storesQuery = useStores();

  const stores: Store[] = storesQuery.data ?? [];
  const active = stores.find((s) => s.id === activeStoreId) ?? null;
  const storeId = active?.id ?? stores[0]?.id ?? null;

  return {
    ...storesQuery,
    stores,
    activeStore: active,
    storeId,
    setActiveStoreId,
  };
}