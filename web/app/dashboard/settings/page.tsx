'use client';

import { useState } from 'react';
import { Activity, Database, MessageCircle, Radio, ServerCrash, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useSelectedStore, STORES_KEY } from '@/hooks/useStores';
import { useHealth } from '@/hooks/useMetrics';
import { api, API_BASE_URL, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import type { Store } from '@/lib/types';

export default function SettingsPage() {
  const { storeId, stores, setActiveStoreId } = useSelectedStore();
  const health = useHealth();
  const queryClient = useQueryClient();

  const [whatsapp, setWhatsapp] = useState({ phoneNumberId: '', wabaId: '', accessToken: '' });

  const saveWhatsapp = useMutation({
    mutationFn: () =>
      api.whatsappChannel({
        storeId: storeId!,
        phoneNumberId: whatsapp.phoneNumberId.trim(),
        wabaId: whatsapp.wabaId.trim() || undefined,
        accessToken: whatsapp.accessToken.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('WhatsApp channel saved');
      setWhatsapp({ phoneNumberId: '', wabaId: '', accessToken: '' });
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Failed to save WhatsApp channel'),
  });

  const disconnect = useMutation({
    mutationFn: async (store: Store) => {
      const res = await fetch(`${API_BASE_URL}/api/stores/${store.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.NEXT_PUBLIC_ADMIN_API_KEY
            ? { 'X-Api-Key': process.env.NEXT_PUBLIC_ADMIN_API_KEY }
            : {}),
        },
      });
      if (!res.ok) {
        let payload: unknown = null;
        try {
          payload = await res.json();
        } catch {
          /* ignore */
        }
        throw new ApiError(res.status, payload);
      }
      return res.json();
    },
    onSuccess: (_data, store) => {
      queryClient.setQueryData<Store[]>(STORES_KEY, (old) => old?.filter((s) => s.id !== store.id) ?? []);
      if (storeId === store.id) setActiveStoreId(null);
      toast.success(`Disconnected ${store.name}`);
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Failed to disconnect store'),
  });

  const healthRows = [
    { key: 'db', label: 'Postgres', ok: health.data?.deps.db },
    { key: 'redis', label: 'Redis', ok: health.data?.deps.redis },
    { key: 'rls', label: 'Row-level security', ok: health.data?.deps.rls },
  ] as const;

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Configure channels, monitor system health and manage connections."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* WhatsApp channel */}
        <Card
          title="WhatsApp channel"
          description="Bind a Meta Cloud API phone number to this store."
          action={<MessageCircle className="h-5 w-5 text-emerald-500" />}
        >
          <div className="space-y-4">
            <Input
              label="Phone number ID"
              placeholder="10223344556…"
              value={whatsapp.phoneNumberId}
              onChange={(e) => setWhatsapp((w) => ({ ...w, phoneNumberId: e.target.value }))}
            />
            <Input
              label="WABA ID (optional)"
              placeholder="WhatsApp Business Account ID"
              value={whatsapp.wabaId}
              onChange={(e) => setWhatsapp((w) => ({ ...w, wabaId: e.target.value }))}
            />
            <Input
              label="Permanent access token (optional)"
              type="password"
              placeholder="System user token"
              hint="Stored encrypted at rest and never returned by the API."
              value={whatsapp.accessToken}
              onChange={(e) => setWhatsapp((w) => ({ ...w, accessToken: e.target.value }))}
            />
            <Button
              onClick={() => saveWhatsapp.mutate()}
              loading={saveWhatsapp.isPending}
              disabled={!storeId || !whatsapp.phoneNumberId.trim()}
              className="w-full sm:w-auto"
            >
              Save channel
            </Button>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Inbound messages are verified with X-Hub-Signature-256 and trigger the agent loop
              automatically once the webhook is subscribed.
            </p>
          </div>
        </Card>

        {/* System health */}
        <Card
          title="System health"
          description="Live dependency ping — refreshes every 30s."
          action={<Activity className={`h-5 w-5 ${health.data?.ok ? 'text-emerald-500' : 'text-red-500'}`} />}
        >
          <div className="space-y-3">
            <div
              className={
                health.data?.ok
                  ? 'flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3'
                  : 'flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3'
              }
            >
              <Radio className={`h-4 w-4 ${health.data?.ok ? 'text-emerald-500' : 'text-red-500'}`} />
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                {health.isLoading
                  ? 'Checking…'
                  : health.data?.ok
                    ? 'All systems operational'
                    : 'System degraded'}
              </p>
            </div>

            <div className="space-y-2">
              {health.isLoading &&
                ['Postgres', 'Redis', 'RLS'].map((label) => (
                  <div key={label} className="flex items-center justify-between rounded-xl border border-slate-200/60 px-4 py-2.5 dark:border-white/5">
                    <span className="text-sm text-slate-500">{label}</span>
                    <span className="h-2 w-2 animate-pulse-dot rounded-full bg-slate-400" />
                  </div>
                ))}
              {!health.isLoading &&
                healthRows.map((row) => (
                  <div
                    key={row.key}
                    className="flex items-center justify-between rounded-xl border border-slate-200/60 px-4 py-2.5 dark:border-white/5"
                  >
                    <span className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                      {row.key === 'db' ? (
                        <Database className="h-4 w-4 text-violet-500" />
                      ) : (
                        <ServerCrash className="h-4 w-4 text-cyan-500" />
                      )}
                      {row.label}
                    </span>
                    {row.ok ? (
                      <Badge variant="success" dot>
                        Healthy
                      </Badge>
                    ) : (
                      <Badge variant="danger" dot>
                        Down
                      </Badge>
                    )}
                  </div>
                ))}
            </div>

            {health.data?.time && (
              <p className="text-xs text-slate-400">
                Last checked {format(new Date(health.data.time), 'HH:mm:ss')} · API{' '}
                <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] dark:bg-white/5">
                  {API_BASE_URL}
                </code>
              </p>
            )}
          </div>
        </Card>
      </div>

      {/* Danger zone */}
      <div className="mt-4">
        <Card
          title="Connected stores"
          description="Disconnect a store to stop the AI agent and its webhooks."
        >
          {stores.length === 0 ? (
            <p className="text-sm text-slate-500">No stores connected.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-white/5">
              {stores.map((store) => (
                <div key={store.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600/20 to-cyan-500/10 text-sm font-bold uppercase text-violet-600 dark:text-violet-300">
                    {store.name[0]}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                      {store.name}
                    </p>
                    <p className="truncate text-xs text-slate-400">{store.shopDomain ?? store.platform}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => disconnect.mutate(store)}
                    loading={disconnect.isPending}
                    disabled={!!storeId && disconnect.isPending}
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                    Disconnect
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}