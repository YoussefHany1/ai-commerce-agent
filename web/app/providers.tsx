'use client';

import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { ThemeProvider } from '@/lib/theme';
import { LocaleProvider } from '@/lib/locale';
import { StoreProvider } from '@/lib/store-context';
import { isPaymentRequired, isSessionExpired, isUnauthorized } from '@/lib/api';

/**
 * Sends the operator to /login when the session cookie is gone or expired.
 *
 * Without this the dashboard only learns the session died when a query fails,
 * and renders "Couldn't load metrics" for a reason that has nothing to do with
 * metrics. A 401 is not retryable either, so without this the default `retry: 2`
 * would burn three attempts per query before surfacing anything.
 *
 * Keyed on `isSessionExpired`, not on the status code: a 401 relayed from the API
 * means the server rejected the request, not that the operator signed out, and
 * bouncing those to /login just loops the operator through a password prompt that
 * cannot possibly fix it.
 */
function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search } = window.location;
  if (pathname === '/login') return;
  const next = encodeURIComponent(`${pathname}${search}`);
  window.location.replace(`/login?next=${next}`);
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error) => {
            if (isSessionExpired(error)) redirectToLogin();
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Neither is worth retrying: a 401 is a rejected credential and a
              // 402 needs a payment. Retrying only delays the message the
              // operator needs to see. This stays on the broad `isUnauthorized`
              // rather than `isSessionExpired` — a request the server refused is
              // not retryable whichever kind of 401 it was.
              if (isUnauthorized(error) || isPaymentRequired(error)) return false;
              return failureCount < 2;
            },
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <LocaleProvider>
          <StoreProvider>{children}</StoreProvider>
        </LocaleProvider>
      </ThemeProvider>
      <Toaster
        position="top-right"
        theme="dark"
        closeButton
        toastOptions={{
          style: {
            background: '#111118',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#F8FAFC',
            borderRadius: '12px',
          },
        }}
      />
    </QueryClientProvider>
  );
}