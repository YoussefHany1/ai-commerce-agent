'use client';

import { useMemo, useState } from 'react';
import { ShieldCheck, Search, ShieldPlus, ShieldMinus } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { api, isSessionExpired } from '@/lib/api';
import { useSession, isOperator } from '@/hooks/useSession';
import type { SupabaseUser } from '@/lib/types';

const ADMINS_KEY = ['supabase-users'] as const;

/**
 * Operator-only admin directory.
 *
 * The admins of this install are chosen from the Supabase Auth users that already
 * exist — this page lists them and grants or revokes the local admin row. It does not
 * create identities: a person signs up or is invited the ordinary way, and only then
 * does an operator decide they administer the install. That keeps "who can sign in" and
 * "who runs the install" as two separate questions, answered in two places.
 *
 * Granting is additive and reversible; revoking deletes the local grant and leaves the
 * Supabase identity alone, because it may still be a merchant. The API is the gate —
 * every call requires the operator session — and the two buttons that could lock the
 * install out (revoking yourself, or the last active admin) are disabled here and
 * refused there, so the UI's state and the API's answer cannot disagree.
 */
export default function AdminsPage() {
  const who = useSession();
  const session = who.data;

  if (!isOperator(session)) {
    return (
      <div>
        <PageHeader title="Admins" description="Who can administer this install." />
        <Card>
          <EmptyState
            icon={<ShieldCheck className="h-6 w-6" />}
            title="Operator access only"
            description="Admin access is granted with the operator session."
          />
        </Card>
      </div>
    );
  }

  return <AdminsDirectory selfOperatorId={session.operatorId} />;
}

function AdminsDirectory({ selfOperatorId }: { selfOperatorId: string }) {
  const queryClient = useQueryClient();
  const directory = useQuery({ queryKey: ADMINS_KEY, queryFn: api.listSupabaseUsers });
  const [filter, setFilter] = useState('');

  const users = useMemo(() => directory.data?.users ?? [], [directory.data]);
  const activeAdmins = useMemo(
    () => users.filter((u) => u.isAdmin && u.status === 'active').length,
    [users],
  );

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? users.filter(
        (u) =>
          (u.email ?? '').toLowerCase().includes(needle) ||
          (u.name ?? '').toLowerCase().includes(needle),
      )
    : users;

  const grant = useMutation({
    mutationFn: (uid: string) => api.grantAdmin(uid),
    onSuccess: (operator) => {
      queryClient.invalidateQueries({ queryKey: ADMINS_KEY });
      toast.success(`${operator.name} can now administer this install`);
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Failed to grant admin access'),
  });

  const revoke = useMutation({
    mutationFn: (operatorId: string) => api.revokeAdmin(operatorId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMINS_KEY });
      toast.success('Admin access revoked');
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Failed to revoke admin access'),
  });

  const busy = grant.isPending || revoke.isPending;

  return (
    <div>
      <PageHeader
        title="Admins"
        description="Grant an existing Supabase user access to this install. Revoking removes the grant, not the account."
      />

      {users.length > 0 && (
        <div className="mb-4 max-w-sm">
          <Input
            placeholder="Search by name or email"
            icon={<Search className="h-4 w-4" />}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      {directory.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card flex items-center gap-4 p-5">
              <Skeleton className="h-9 w-9 rounded-xl" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
          ))}
        </div>
      ) : visible.length > 0 ? (
        <div className="space-y-3">
          {visible.map((user) => (
            <AdminRow
              key={user.uid ?? user.operatorId ?? user.email ?? 'orphan'}
              user={user}
              selfOperatorId={selfOperatorId}
              activeAdmins={activeAdmins}
              busy={busy}
              onGrant={() => user.uid && grant.mutate(user.uid)}
              onRevoke={() => user.operatorId && revoke.mutate(user.operatorId)}
            />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<ShieldCheck className="h-6 w-6" />}
            title={users.length ? 'No matches' : 'No Supabase users yet'}
            description={
              users.length
                ? 'Try a different name or email.'
                : 'Invite or register an account first, then grant it admin access here.'
            }
          />
        </Card>
      )}

      {directory.isError && (
        <p className="mt-4 text-sm text-red-500">
          {isSessionExpired(directory.error)
            ? 'Your session has expired. Please sign in again.'
            : 'Couldn’t load the Supabase directory. Check that the API is running.'}
        </p>
      )}
    </div>
  );
}

function AdminRow({
  user,
  selfOperatorId,
  activeAdmins,
  busy,
  onGrant,
  onRevoke,
}: {
  user: SupabaseUser;
  selfOperatorId: string;
  activeAdmins: number;
  busy: boolean;
  onGrant: () => void;
  onRevoke: () => void;
}) {
  const label = user.name || user.email || 'Unnamed user';
  const initial = label[0]?.toUpperCase() ?? '?';
  const isSelf = user.operatorId !== null && user.operatorId === selfOperatorId;
  const isLastActive = user.isAdmin && user.status === 'active' && activeAdmins <= 1;

  return (
    <Card>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600/20 to-cyan-500/10 text-sm font-bold uppercase text-violet-600 dark:text-violet-300">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <span className="truncate">{label}</span>
            {isSelf && <Badge variant="info">You</Badge>}
            {user.isAdmin && (
              <Badge variant={user.status === 'suspended' ? 'danger' : 'success'} dot>
                {user.status === 'suspended' ? 'Admin (suspended)' : 'Admin'}
              </Badge>
            )}
          </p>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">
            {user.email ?? 'No email on this Supabase user'}
            {user.lastSignInAt
              ? ` · last seen ${format(new Date(user.lastSignInAt), 'MMM d, yyyy')}`
              : user.uid
                ? ' · never signed in'
                : ' · identity no longer in Supabase'}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2">
          {user.isAdmin ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRevoke}
              loading={busy}
              disabled={isSelf || isLastActive}
              title={
                isSelf
                  ? 'You cannot revoke your own access'
                  : isLastActive
                    ? 'The last active admin cannot be revoked'
                    : undefined
              }
            >
              <ShieldMinus className="h-4 w-4" />
              Revoke
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={onGrant}
              loading={busy}
              disabled={!user.uid}
            >
              <ShieldPlus className="h-4 w-4" />
              Make admin
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
