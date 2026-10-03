'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { SessionInfo } from '@/lib/types';

export const SESSION_KEY = ['session'] as const;

/**
 * The principal behind the current cookie: operator, client account, or signed
 * out. Consumed by the shell (sidebar, topbar) and by operator-only pages to
 * avoid mounting admin UI in front of a client session.
 */
export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: api.sessionInfo,
    staleTime: 60_000,
    retry: false,
  });
}

export function isOperator(
  session: SessionInfo | undefined,
): session is Extract<SessionInfo, { kind: 'operator' }> {
  return session?.authenticated === true && session.kind === 'operator';
}

export function isClient(
  session: SessionInfo | undefined,
): session is Extract<SessionInfo, { kind: 'client' }> {
  return session?.authenticated === true && session.kind === 'client';
}