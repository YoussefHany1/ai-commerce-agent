'use client';

import { useState } from 'react';
import { KeyRound, Plus, Store as StoreIcon, Users } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { api, isSessionExpired } from '@/lib/api';
import { useSession, isOperator } from '@/hooks/useSession';
import type { ClientAccount, ClientCreateResult } from '@/lib/types';

const CLIENTS_KEY = ['clients'] as const;

/**
 * Operator-only tenant administration: clients are invited accounts, so they
 * only exist because this surface (or the `client:create` script) created them,
 * and everything here is back-office work an account must never do to itself.
 *
 * The API is still the gate: every route on this page requires the admin key,
 * which the proxy only attaches to an operator session. The session check here
 * is just so a client session is not shown a page that immediately 401s.
 */
export default function ClientsPage() {
  const who = useSession();

  if (!isOperator(who.data)) {
    return (
      <div>
        <PageHeader title="Clients" description="Tenant accounts on this install." />
        <Card>
          <EmptyState
            icon={<Users className="h-6 w-6" />}
            title="Operator access only"
            description="Client accounts are managed with the operator session."
          />
        </Card>
      </div>
    );
  }

  return <ClientsAdmin />;
}

function ClientsAdmin() {
  const queryClient = useQueryClient();
  const clients = useQuery({ queryKey: CLIENTS_KEY, queryFn: api.listClients });
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [credential, setCredential] = useState<ClientCreateResult | null>(null);
  const [resetFor, setResetFor] = useState<ClientAccount | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createClient({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password.trim() || undefined,
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: CLIENTS_KEY });
      setShowCreate(false);
      setForm({ name: '', email: '', password: '' });
      setErrors({});
      setCredential(result.temporaryPassword ? result : null);
      toast.success(`Created ${result.name}`);
    },
    onError: (err: unknown) => {
      if (err instanceof Error && err.message === 'client_already_exists') {
        setErrors({ email: 'An account with this email already exists.' });
        return;
      }
      toast.error(err instanceof Error ? err.message : 'Failed to create account');
    },
  });

  const toggleStatus = useMutation({
    mutationFn: (account: ClientAccount) =>
      api.setClientStatus(account.id, account.status === 'active' ? 'suspended' : 'active'),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: CLIENTS_KEY });
      toast.success(result.status === 'suspended' ? 'Account suspended' : 'Account reactivated');
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Failed to change status'),
  });

  const reset = useMutation({
    mutationFn: () => api.resetClientPassword(resetFor!.id, resetPassword),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CLIENTS_KEY });
      setResetFor(null);
      setResetPassword('');
      toast.success('Password reset');
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Failed to reset password'),
  });

  const openCreate = () => {
    setForm({ name: '', email: '', password: '' });
    setErrors({});
    setShowCreate(true);
  };

  const submit = () => {
    const next: { name?: string; email?: string } = {};
    if (!form.name.trim()) next.name = 'Name is required';
    if (!form.email.trim() || !form.email.includes('@')) next.email = 'A valid email is required';
    setErrors(next);
    if (Object.keys(next).length === 0) create.mutate();
  };

  return (
    <div>
      <PageHeader
        title="Clients"
        description="Invite merchant accounts and manage their access. Accounts are invite-only — there is no public signup."
      >
        <Button onClick={openCreate} leftIcon={<Plus className="h-4 w-4" />}>
          Add client
        </Button>
      </PageHeader>

      {clients.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card flex items-center gap-4 p-5">
              <Skeleton className="h-9 w-9 rounded-xl" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
          ))}
        </div>
      ) : clients.data && clients.data.length > 0 ? (
        <div className="space-y-3">
          {clients.data.map((account) => (
            <Card key={account.id}>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600/20 to-cyan-500/10 text-sm font-bold uppercase text-violet-600 dark:text-violet-300">
                  {account.name[0]}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {account.name}
                    <Badge variant={account.status === 'active' ? 'success' : 'danger'} dot>
                      {account.status}
                    </Badge>
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {account.email} · created{' '}
                    {format(new Date(account.createdAt), 'MMM d, yyyy')}
                  </p>
                </div>
                <div className="flex items-center gap-4 sm:gap-6">
                  <span className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                    <StoreIcon className="h-3.5 w-3.5" />
                    {account.storeCount} {account.storeCount === 1 ? 'store' : 'stores'}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setResetFor(account);
                        setResetPassword('');
                      }}
                      disabled={reset.isPending}
                    >
                      <KeyRound className="h-4 w-4" />
                      Reset password
                    </Button>
                    <Button
                      variant={account.status === 'active' ? 'ghost' : 'secondary'}
                      size="sm"
                      onClick={() => toggleStatus.mutate(account)}
                      loading={toggleStatus.isPending}
                    >
                      {account.status === 'active' ? 'Suspend' : 'Reactivate'}
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<Users className="h-6 w-6" />}
            title="No clients yet"
            description="Create an account and share its temporary password to invite a merchant."
            action={
              <Button onClick={openCreate} leftIcon={<Plus className="h-4 w-4" />}>
                Add your first client
              </Button>
            }
          />
        </Card>
      )}

      {clients.isError && (
        <p className="mt-4 text-sm text-red-500">
          {isSessionExpired(clients.error)
            ? 'Your session has expired. Please sign in again.'
            : 'Couldn’t load clients. Check that the API is running.'}
        </p>
      )}

      {/* Create account modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add a client"
        description="Creates an invite-only account. Leave the password blank to generate a temporary one."
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={submit} loading={create.isPending} leftIcon={<Plus className="h-4 w-4" />}>
              Create client
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            placeholder="Ace Widgets"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            error={errors.name}
          />
          <Input
            label="Email"
            type="email"
            placeholder="owner@example.com"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            error={errors.email}
          />
          <Input
            label="Password (optional)"
            type="password"
            autoComplete="new-password"
            placeholder="Leave blank to generate"
            hint="Generated temporary passwords are shown once and must be changed on first login."
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
          />
        </div>
      </Modal>

      {/* One-time credential hand-off */}
      <Modal
        open={!!credential}
        onClose={() => setCredential(null)}
        title="Invite this client"
        description="Share these credentials once. They are not stored again."
        closeOnBackdrop={false}
        footer={
          <Button onClick={() => setCredential(null)}>I’ve copied them</Button>
        }
      >
        <div className="space-y-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Email</p>
            <p className="truncate text-sm font-semibold">{credential?.email}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Temporary password</p>
            <p className="font-mono text-sm font-semibold tracking-wide">{credential?.temporaryPassword}</p>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            The invite holder signs in on the Store login tab and should change this immediately.
          </p>
        </div>
      </Modal>

      {/* Reset password modal */}
      <Modal
        open={!!resetFor}
        onClose={() => setResetFor(null)}
        title={`Reset password for ${resetFor?.name ?? 'client'}`}
        description="The account’s current sessions are revoked. Set a value the invitee knows or shares immediately."
        footer={
          <>
            <Button variant="secondary" onClick={() => setResetFor(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => reset.mutate()}
              loading={reset.isPending}
              disabled={resetPassword.length < 8}
            >
              Reset password
            </Button>
          </>
        }
      >
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          value={resetPassword}
          onChange={(e) => setResetPassword(e.target.value)}
        />
      </Modal>
    </div>
  );
}