import type {
  AttributionsResponse,
  AutomationRule,
  AutomationRulesResponse,
  AutomationTemplatesResponse,
  AutomationTriggerConfig,
  MessageTemplate,
  BillingStatus,
  ChatResponse,
  ChatResult,
  CheckoutResponse,
  ClientAccount,
  ClientCreateResult,
  ConversionLagResponse,
  HealthResponse,
  JobsResponse,
  MetricsResponse,
  SessionInfo,
  SourcesResponse,
  Store,
  TopProductsResponse,
} from '@/lib/types';

/**
 * Public origin of the API, used only where the browser must navigate to or read
 * it: the OAuth install link and the webhook base URL shown to the operator.
 *
 * Data calls do NOT go here. They are same-origin requests to this app's own
 * `/api/*` proxy, which attaches the operator credential server-side. Nothing in
 * this file may read a privileged secret — anything referenced by a `'use client'`
 * module is inlined into the public bundle.
 */
export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

/**
 * WhatsApp Web pairing state, mirroring `GET /api/whatsapp/qr-status`.
 *
 * `status` distinguishes `logged_out` and `replaced` from a generic error because they
 * need different recovery — one needs a re-scan, the other usually just a reconnect —
 * and collapsing them into `error` would show a merchant the wrong remedy.
 */
export type QrStatus = {
  enabled: boolean;
  tosAcknowledged: boolean;
  tosVersion: string;
  status: 'idle' | 'connecting' | 'qr' | 'open' | 'logged_out' | 'replaced' | 'error';
  phone: string | null;
  lastError: string | null;
  maxSessions: number;
};

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  /** Caller-supplied abort signal, combined with the request timeout. */
  signal?: AbortSignal;
  /** Override the default per-request timeout. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const payload = body as { error?: string; message?: string } | null;
    const message =
      payload?.message ??
      payload?.error ??
      `Request failed with status ${status}`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.error ?? null;
    this.body = body;
  }
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, headers, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const qs = query
    ? new URLSearchParams(
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : '';
  // Call sites spell the path with or without the `/api` prefix, and the prefix is
  // what the proxy route is mounted under. Normalize to exactly one so neither
  // spelling can produce `/api/api/...`.
  const suffix = path === '/api' || path.startsWith('/api/') ? path.slice('/api'.length) : path;
  const url = `/api${suffix}${qs ? `?${qs}` : ''}`;

  const reqHeaders: Record<string, string> = { ...(headers ?? {}) };
  if (body !== undefined) reqHeaders['Content-Type'] = 'application/json';

  // A hung upstream otherwise pins the UI forever; race the fetch against a
  // timeout and fold in any caller-provided signal.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: reqHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Same-origin, so the HTTP-only session cookie rides along.
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    // Distinguish our timeout from a caller-driven abort (navigation/unmount).
    if (controller.signal.aborted && !signal?.aborted) {
      throw new ApiError(408, {
        error: 'request_timeout',
        message: 'The request timed out. Please try again.',
      });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
  }

  const text = await res.text();
  const payload: unknown = text ? safeParse(text) : null;

  if (!res.ok) {
    throw new ApiError(res.status, payload);
  }
  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),

  listStores: () => request<Store[]>('/stores'),

  deleteStore: (storeId: string) => request<{ ok: true }>(`/stores/${storeId}`, { method: 'DELETE' }),

  createStore: (input: {
    name: string;
    platform: string;
    shopDomain?: string;
    accessToken?: string;
  }) =>
    request<{ id: string }>('/stores', {
      method: 'POST',
      body: input,
    }),

  metrics: (storeId: string, days = 14) =>
    request<MetricsResponse>(`/api/metrics/${storeId}`, { query: { days } }),

  attributions: (storeId: string, status?: 'recommended' | 'clicked' | 'converted') =>
    request<AttributionsResponse>(`/api/analytics/${storeId}/attributions`, {
      query: { status },
    }),

  sources: (storeId: string) =>
    request<SourcesResponse>(`/api/analytics/${storeId}/sources`),

  topProducts: (storeId: string, limit = 10) =>
    request<TopProductsResponse>(`/api/analytics/${storeId}/top-products`, {
      query: { limit },
    }),

  conversionLag: (storeId: string, days = 14) =>
    request<ConversionLagResponse>(`/api/analytics/${storeId}/conversion-lag`, {
      query: { days },
    }),

  billingStatus: (storeId: string) =>
    request<BillingStatus>(`/api/billing/status/${storeId}`),

  billingCheckout: (storeId: string, plan: 'pro' | 'enterprise') =>
    request<CheckoutResponse>('/api/billing/checkout', {
      method: 'POST',
      body: { storeId, plan },
    }),

  billingPortal: (storeId: string) =>
    request<CheckoutResponse>('/api/billing/portal', {
      method: 'POST',
      body: { storeId },
    }),

  whatsappChannel: (input: {
    storeId: string;
    phoneNumberId: string;
    wabaId?: string;
    accessToken?: string;
  }) =>
    request<{ ok: true }>('/api/whatsapp/channels', {
      method: 'POST',
      body: input,
    }),

  whatsappChannels: () => request<Array<{ id: string; storeId: string; phoneNumberId: string; wabaId: string | null; createdAt: string }>>('/api/whatsapp/channels'),

  /**
   * WhatsApp Web (QR) pairing state.
   *
   * `status` is the live socket state when this replica holds the number, falling back
   * to the persisted value — which is why the card must load this on mount instead of
   * trusting only live events: after a redeploy the socket is briefly absent and the
   * stored status is the honest answer.
   */
  whatsappQrStatus: (storeId: string) =>
    request<QrStatus>(`/api/whatsapp/qr-status?storeId=${encodeURIComponent(storeId)}`),

  /** Records acceptance of the unofficial-protocol warning. Must precede qrConnect. */
  whatsappQrAcknowledge: (storeId: string) =>
    request<{ ok: true; version: string }>('/api/whatsapp/qr-acknowledge', {
      method: 'POST',
      body: { storeId },
    }),

  /**
   * Starts pairing. Rejects with `tos_not_acknowledged` until the warning is accepted
   * and `session_limit_reached` when the one-number limit is met — both are surfaced
   * rather than retried.
   */
  whatsappQrConnect: (storeId: string) =>
    request<{ ok: true; resumed: boolean }>('/api/whatsapp/qr-connect', {
      method: 'POST',
      body: { storeId },
    }),

  /** Unlinks the number from WhatsApp and drops the stored pairing. */
  whatsappQrDisconnect: (storeId: string) =>
    request<{ ok: true }>('/api/whatsapp/qr-disconnect', {
      method: 'DELETE',
      body: { storeId },
    }),

  automationRules: (storeId: string) =>
    request<AutomationRulesResponse>(`/api/automation/rules/${storeId}`),

  createAutomationRule: (input: {
    storeId: string;
    triggerType: AutomationRule['triggerType'];
    triggerConfig?: AutomationTriggerConfig;
    action: AutomationRule['action'];
    enabled?: boolean;
    cooldownMinutes?: number;
    lookbackHours?: number;
  }) =>
    request<{ id: string }>('/api/automation/rules', {
      method: 'POST',
      body: input,
    }),

  updateAutomationRule: (
    ruleId: string,
    patch: Partial<{
      triggerType: AutomationRule['triggerType'];
      triggerConfig: AutomationTriggerConfig;
      action: AutomationRule['action'];
      enabled: boolean;
      cooldownMinutes: number;
      lookbackHours: number;
    }> & { storeId: string },
  ) =>
    request<{ ok: true }>(`/api/automation/rules/${ruleId}`, {
      method: 'PUT',
      body: patch,
    }),

  automationTemplates: (storeId: string) =>
    request<AutomationTemplatesResponse>(`/api/automation/templates/${storeId}`),

  /** Replaces the whole saved-template list for the store. */
  saveAutomationTemplates: (storeId: string, templates: MessageTemplate[]) =>
    request<{ ok: true }>(`/api/automation/templates/${storeId}`, {
      method: 'PUT',
      body: { templates },
    }),

  deleteAutomationRule: (ruleId: string, storeId: string) =>
    request<{ ok: true }>(`/api/automation/rules/${ruleId}`, {
      method: 'DELETE',
      body: { storeId },
    }),

  jobs: (storeId: string, status?: string) =>
    request<JobsResponse>(`/api/jobs/${storeId}`, { query: { status } }),

  /**
   * Operator account admin. These are only meaningful to an operator session:
   * a client's proxied call reaches the API without an admin key and gets a 401,
   * so the dashboard gates the page in the UI as well.
   */
  listClients: () => request<ClientAccount[]>('/clients'),

  createClient: (input: { name: string; email: string; password?: string }) =>
    request<ClientCreateResult>('/clients', { method: 'POST', body: input }),

  setClientStatus: (clientId: string, status: 'active' | 'suspended') =>
    request<{ ok: true; status: 'active' | 'suspended' }>(`/clients/${clientId}/status`, {
      method: 'PATCH',
      body: { status },
    }),

  resetClientPassword: (clientId: string, password: string) =>
    request<{ ok: true }>(`/clients/${clientId}/reset-password`, {
      method: 'POST',
      body: { password },
    }),

  chat: async (storeId: string, message: string): Promise<ChatResult> => {
    const sessionRes = await request<{ token: string; conversationId: string }>('/api/session', {
      method: 'POST',
      body: { storeId },
    });
    const res = await request<ChatResponse>('/api/chat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionRes.token}` },
      body: { message },
    });
    // Hand the token back so a recommendation click on this turn can be
    // attributed. It is a short-lived guest token already in this tab's memory.
    return { ...res, token: sessionRes.token };
  },

  attributionClick: (token: string, productId: string) =>
    request<{ ok: true }>('/api/attributions/click', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { productId },
    }),

  embedKey: (storeId: string) =>
    request<{ storeId: string; embedKey: string | null }>(`/api/stores/${storeId}/embed-key`),

  /**
   * Returns the store's existing embed key, minting one on first call.
   * `rotate` invalidates the old key immediately, which is the revoke path for a
   * key that ended up somewhere the merchant no longer controls.
   */
  ensureEmbedKey: (storeId: string, rotate = false) =>
    request<{ storeId: string; embedKey: string; created: boolean }>(
      `/api/stores/${storeId}/embed-key`,
      { method: 'POST', body: { rotate } },
    ),

  /**
   * Clears the operator session cookie server-side.
   *
   * Not routed through the catch-all proxy: `/api/auth/logout` is a dedicated
   * route handler that only has to expire its own cookie, so proxying it would
   * add an upstream round-trip that can fail when the very thing being signed
   * out of is already broken. A failure here still redirects, because leaving
   * the operator on a page they cannot load is worse than a stale cookie that
   * the next successful login overwrites.
   */
  signOut: async (): Promise<void> => {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  },

  /**
   * Public client auth flows. These hit dedicated BFF route handlers (never the
   * catch-all proxy, which requires a session): exchanging a Supabase token for
   * the `aca_session` cookie happens server-side on Google sign-in, password
   * reset, and signup confirmation, while the forms below only kick those flows
   * off or finish the parts that cannot be left to the server.
   */
  register: (input: { name: string; email: string; password: string }) =>
    request<{ ok: true }>('/api/auth/register', { method: 'POST', body: input }),

  forgot: (email: string) =>
    request<{ ok: true }>('/api/auth/forgot', { method: 'POST', body: { email } }),

  resetPassword: (input: { email: string; token: string; password: string }) =>
    request<{ ok: true }>('/api/auth/reset', { method: 'POST', body: input }),

  /**
   * Reads the current session so the shell can branch on principal kind.
   *
   * Also served by a dedicated route handler, not the proxy — the session cookie
   * is verified locally against Redis, so proxying it would add a needless
   * upstream round-trip. A non-OK response always maps to "signed out": a caller
   * only needs to know whether there is a live session and of which kind.
   */
  sessionInfo: async (): Promise<SessionInfo> => {
    let res: Response;
    try {
      res = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    } catch {
      return { authenticated: false };
    }
    if (!res.ok) return { authenticated: false };
    try {
      const body = (await res.json()) as SessionInfo;
      return body && typeof body.authenticated === 'boolean' ? body : { authenticated: false };
    } catch {
      return { authenticated: false };
    }
  },
};

export function isPaymentRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 402;
}

/** True when the failure is any 401, from this proxy or a relayed upstream one. */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * True only when the operator session itself is gone or expired.
 *
 * Narrower than {@link isUnauthorized} on purpose. A 401 can also arrive
 * *relayed* from the API — a store credential rejection, or an admin key that no
 * longer matches between the two services — and none of those are fixed by
 * signing in again. Only the proxy's own `session_expired` code means the cookie
 * is dead, so only that may redirect to /login; treating every 401 as an expired
 * session turned a backend misconfiguration into an endless sign-in loop.
 */
export function isSessionExpired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && err.code === 'session_expired';
}