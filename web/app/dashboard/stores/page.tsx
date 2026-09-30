'use client';

import { useState } from 'react';
import { Plus, Store as StoreIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { StoreCard } from '@/components/dashboard/StoreCard';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSelectedStore, useCreateStore, STORES_KEY } from '@/hooks/useStores';
import { useSession, isClient } from '@/hooks/useSession';
import { api, isSessionExpired } from '@/lib/api';
import type { Store } from '@/lib/types';

const PLATFORM_OPTIONS = [
  { value: 'shopify', label: 'Shopify' },
  { value: 'salla', label: 'Salla' },
  { value: 'zid', label: 'Zid' },
];

interface FormState {
  name: string;
  platform: string;
  shopDomain: string;
  accessToken: string;
}

const emptyForm: FormState = { name: '', platform: 'shopify', shopDomain: '', accessToken: '' };

export default function StoresPage() {
  const { stores, isLoading, isError, error, storeId, setActiveStoreId } = useSelectedStore();
  const createStore = useCreateStore();
  const queryClient = useQueryClient();
  const who = useSession();
  // The Shopify OAuth install is an operator flow: its callback creates a store
  // keyed to the operator, which a client account cannot see. Clients connect
  // stores by pasting credentials instead.
  const clientSession = isClient(who.data);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Partial<FormState>>({});
  const [toDisconnect, setToDisconnect] = useState<Store | null>(null);

  const disconnect = useMutation({
    mutationFn: (store: Store) => api.deleteStore(store.id),
    onSuccess: (_data, store) => {
      queryClient.setQueryData<Store[]>(STORES_KEY, (old) => old?.filter((s) => s.id !== store.id) ?? []);
      if (storeId === store.id) setActiveStoreId(null);
      toast.success(`Disconnected ${store.name}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to disconnect store');
    },
    onSettled: () => setToDisconnect(null),
  });

  const openAdd = () => {
    setForm(emptyForm);
    setErrors({});
    setShowAdd(true);
  };

  const validate = (): boolean => {
    const next: Partial<FormState> = {};
    if (!form.name.trim()) next.name = 'Store name is required';
    if (!form.shopDomain.trim()) next.shopDomain = 'Shop domain is required';
    // Required for every platform, Shopify included. A store created without a token
    // cannot build a commerce adapter, so every catalog/order sync for it dies with
    // `no_connection` and the dashboard shows an empty funnel with no error anywhere.
    // Operators who would rather not paste a token should use the OAuth button below.
    if (!form.accessToken.trim()) {
      next.accessToken = 'An access token is required — without it the store can never sync';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    try {
      await createStore.mutateAsync({
        name: form.name.trim(),
        platform: form.platform,
        shopDomain: form.shopDomain.trim() || undefined,
        accessToken: form.accessToken.trim() || undefined,
      });
      toast.success('Store connected');
      setShowAdd(false);
    } catch {
      /* error toast handled by hook */
    }
  };

  /**
   * Starts the Shopify install. `redirectAfter` sends the merchant back to this
   * dashboard once the callback completes — without it the API answers with raw
   * JSON, which is a dead end for the person installing. The API only honours it
   * for origins listed in OAUTH_REDIRECT_ALLOWLIST.
   *
   * Same-origin on purpose: `/api/oauth/shopify/start` is proxied by this app so the
   * session cookie is attached and the API can scope the new store to the signed-in
   * account. Navigating straight at the API would drop the cookie and install the
   * store as operator-owned, which the client cannot then see.
   */
  const startShopifyOAuth = (shopDomain: string) => {
    const url = new URL('/api/oauth/shopify/start', window.location.origin);
    url.searchParams.set('shop', shopDomain);
    url.searchParams.set('redirectAfter', `${window.location.origin}/dashboard/stores`);
    window.location.href = url.toString();
  };

  return (
    <div>
      <PageHeader
        title="Stores"
        description="Connect and manage your Shopify, Salla and Zid stores."
      >
        <Button onClick={openAdd} leftIcon={<Plus className="h-4 w-4" />}>
          Add store
        </Button>
      </PageHeader>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card p-5">
              <div className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-xl" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="mt-4 h-3 w-40" />
            </div>
          ))}
        </div>
      ) : stores.length === 0 ? (
        <Card>
          <EmptyState
            icon={<StoreIcon className="h-6 w-6" />}
            title="No stores yet"
            description="Add your first store to start the AI sales agent."
            action={
              <Button onClick={openAdd} leftIcon={<Plus className="h-4 w-4" />}>
                Add your first store
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {stores.map((store) => (
            <StoreCard
              key={store.id}
              store={store}
              selected={store.id === storeId}
              onSelect={() => setActiveStoreId(store.id)}
              onDisconnect={setToDisconnect}
            />
          ))}
          <button
            onClick={openAdd}
            className="flex min-h-[150px] items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 text-sm font-medium text-slate-400 transition hover:border-violet-400/50 hover:text-violet-500 dark:border-white/10"
          >
            <Plus className="h-5 w-5" /> Connect another store
          </button>
        </div>
      )}

      {isError && (
        <p className="mt-4 text-sm text-red-500">
          {isSessionExpired(error)
            ? 'Your session has expired. Please sign in again.'
            : 'Couldn’t load stores. Check that the API is running.'}
        </p>
      )}

      {/* Add store modal */}
      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add a store"
        description="Connect a commerce platform to activate your AI agent."
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button onClick={submit} loading={createStore.isPending} leftIcon={<Plus className="h-4 w-4" />}>
              Connect store
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Store name"
            placeholder="My Store"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            error={errors.name}
          />

          <Select
            label="Platform"
            options={PLATFORM_OPTIONS}
            value={form.platform}
            onChange={(e) => setForm((f) => ({ ...f, platform: e.target.value }))}
          />

          {form.platform === 'shopify' && (
            <div className="flex flex-col gap-2 rounded-xl border border-violet-200/70 bg-violet-50/40 p-4 dark:border-violet-400/20 dark:bg-violet-500/[0.06]">
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                Recommended: connect with Shopify
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Grants the app the scopes it needs and registers webhooks, so orders and
                catalog updates arrive live. Paste a token below only if you cannot
                install the app.
              </p>
              {form.shopDomain.trim() ? (
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => startShopifyOAuth(form.shopDomain.trim())}
                >
                  Connect with Shopify OAuth
                </Button>
              ) : (
                <p className="text-xs text-slate-400">Enter your shop domain to enable OAuth.</p>
              )}
            </div>
          )}

          <Input
            label="Shop domain"
            placeholder="shop.myshopify.com"
            hint="e.g. shop.myshopify.com"
            value={form.shopDomain}
            onChange={(e) => setForm((f) => ({ ...f, shopDomain: e.target.value }))}
            error={errors.shopDomain}
          />

          <Input
            label="Access token"
            placeholder="shpat_…"
            type="password"
            hint={
              clientSession
                ? 'Required. Create one in your platform admin and paste it here — it is checked against the platform before the store is saved.'
                : 'Required when not using OAuth. It is checked against the platform before the store is saved.'
            }
            value={form.accessToken}
            onChange={(e) => setForm((f) => ({ ...f, accessToken: e.target.value }))}
            error={errors.accessToken}
          />
        </div>
      </Modal>

      {/* Disconnect confirm */}
      <ConfirmDialog
        open={!!toDisconnect}
        onClose={() => setToDisconnect(null)}
        onConfirm={() => toDisconnect && disconnect.mutate(toDisconnect)}
        loading={disconnect.isPending}
        title={`Disconnect ${toDisconnect?.name ?? 'store'}?`}
        description="This removes the store and its AI agent. Analytics data is kept for legal/accounting records."
        confirmLabel="Disconnect"
      />
    </div>
  );
}