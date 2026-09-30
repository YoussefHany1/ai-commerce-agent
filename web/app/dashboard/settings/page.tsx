'use client';

import { useMemo, useState } from 'react';
import { Activity, Code2, Database, MessageCircle, Radio, ServerCrash, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useSelectedStore, STORES_KEY } from '@/hooks/useStores';
import { useHealth } from '@/hooks/useMetrics';
import { api, API_BASE_URL } from '@/lib/api';
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

  const embed = useQuery({
    queryKey: ['embed-key', storeId],
    queryFn: () => api.embedKey(storeId!),
    enabled: !!storeId,
  });

  const createKey = useMutation({
    mutationFn: (rotate: boolean) => api.ensureEmbedKey(storeId!, rotate),
    onSuccess: (data, rotate) => {
      queryClient.setQueryData(['embed-key', storeId], { storeId: data.storeId, embedKey: data.embedKey });
      toast.success(rotate ? 'Key rotated — update the snippet on your storefront' : 'Snippet ready');
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Could not create an embed key'),
  });

  const activeStore = stores.find((s) => s.id === storeId);

  /**
   * The widget is served from this app and talks to the API directly, because it
   * runs on the merchant's origin and cannot use this app's same-origin proxy.
   */
  const snippet = useMemo(() => {
    const key = embed.data?.embedKey;
    if (!key) return '';
    return [
      `<script`,
      `  src="${typeof window === 'undefined' ? '' : window.location.origin}/widget.js"`,
      `  data-api="${API_BASE_URL}"`,
      `  data-key="${key}"`,
      `  data-store="${(activeStore?.name ?? 'Store').replace(/"/g, '&quot;')}"`,
      `  defer></script>`,
    ].join('\n');
  }, [embed.data?.embedKey, activeStore?.name]);

  const originsHint = activeStore?.shopDomain
    ? `your storefront (${activeStore.shopDomain})`
    : "the store's own domain";

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
    mutationFn: (store: Store) => api.deleteStore(store.id),
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

        {/* Storefront widget */}
        <Card
          title="Storefront widget"
          description="Put the AI agent on your own storefront. Clicks and purchases then land in Analytics."
          action={<Code2 className="h-5 w-5 text-violet-500" />}
        >
          <div className="space-y-4">
            {!embed.data?.embedKey ? (
              <>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Generate a snippet to paste into your theme. Without it, recommendations
                  happen only inside this dashboard and never reach your customers.
                </p>
                <Button
                  onClick={() => createKey.mutate(false)}
                  loading={createKey.isPending}
                  disabled={!storeId || embed.isLoading}
                  className="w-full sm:w-auto"
                >
                  Generate embed snippet
                </Button>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                    Paste this before <code className="rounded bg-slate-100 px-1 dark:bg-white/10">&lt;/body&gt;</code>:
                  </p>
                  <textarea
                    readOnly
                    rows={5}
                    value={snippet}
                    onFocus={(e) => e.currentTarget.select()}
                    className="w-full resize-none rounded-xl border border-slate-200/60 bg-slate-50/70 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-slate-700 dark:border-white/5 dark:bg-white/[0.03] dark:text-slate-300"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        navigator.clipboard
                          ?.writeText(snippet)
                          .then(() => toast.success('Snippet copied'))
                          .catch(() => toast.error('Copy failed — select the text and copy manually'));
                      }}
                    >
                      Copy snippet
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => createKey.mutate(true)}
                      loading={createKey.isPending}
                    >
                      Rotate key
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  The key is public — it can only start a chat with this store, and only from{' '}
                  {originsHint}. On a custom domain, add that domain to{' '}
                  <code className="rounded bg-slate-100 px-1 dark:bg-white/10">settings.widgetOrigins</code>{' '}
                  or the widget will be refused. Rotating invalidates the old snippet immediately.
                </p>
              </>
            )}
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