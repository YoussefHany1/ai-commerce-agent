'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export const STORE_STORAGE_KEY = 'aca.activeStoreId';

interface StoreContextValue {
  activeStoreId: string | null;
  setActiveStoreId: (id: string | null) => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [activeStoreId, setActiveStoreIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORE_STORAGE_KEY);
  });

  const setActiveStoreId = useCallback((id: string | null) => {
    if (id) {
      localStorage.setItem(STORE_STORAGE_KEY, id);
    } else {
      localStorage.removeItem(STORE_STORAGE_KEY);
    }
    setActiveStoreIdState(id);
  }, []);

  useEffect(() => {
    if (!activeStoreId) return;
    localStorage.setItem(STORE_STORAGE_KEY, activeStoreId);
  }, [activeStoreId]);

  const value = useMemo(
    () => ({ activeStoreId, setActiveStoreId }),
    [activeStoreId, setActiveStoreId],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useActiveStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useActiveStore must be used within StoreProvider');
  return ctx;
}