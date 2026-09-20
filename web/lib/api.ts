import type {
  AttributionsResponse,
  AutomationRule,
  AutomationRulesResponse,
  BillingStatus,
  ChatResponse,
  CheckoutResponse,
  ConversionLagResponse,
  HealthResponse,
  JobsResponse,
  MetricsResponse,
  SourcesResponse,
  Store,
  TopProductsResponse,
} from '@/lib/types';

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

const ADMIN_API_KEY = process.env.NEXT_PUBLIC_ADMIN_API_KEY ?? '';

interface StoreCredentials {
  storeId: string;
  apiKey: string;
}

function storedCredentials(): StoreCredentials | null {
  const storeId = localStorage.getItem('store_id');
  const apiKey = localStorage.getItem('store_api_key');
  if (!storeId || !apiKey) return null;
  return { storeId, apiKey };
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
}

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
  const { method = 'GET', body, query, headers } = opts;
  const qs = query
    ? new URLSearchParams(
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : '';
  const url = `${API_BASE_URL}${path}${qs ? `?${qs}` : ''}`;

  const reqHeaders: Record<string, string> = { ...(headers ?? {}) };
  if (body !== undefined) reqHeaders['Content-Type'] = 'application/json';
  if (ADMIN_API_KEY) reqHeaders['X-Api-Key'] = ADMIN_API_KEY;
  else if (typeof window !== 'undefined') {
    const cred = storedCredentials();
    if (cred) {
      reqHeaders['X-Store-Id'] = cred.storeId;
      reqHeaders['X-Api-Key'] = cred.apiKey;
    }
  }

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

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

  listStores: () => request<Store[]>('/api/stores'),
  createStore: (input: {
    name: string;
    platform: string;
    shopDomain?: string;
    accessToken?: string;
  }) =>
    request<{ id: string }>('/api/stores', {
      method: 'POST',
      body: input,
    }),

  metrics: (storeId: string, days = 14) =>
    request<MetricsResponse>(`/api/metrics/${storeId}`, { query: { days } }),

  attributions: (storeId: string, status?: 'clicked' | 'converted') =>
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

  automationRules: (storeId: string) =>
    request<AutomationRulesResponse>(`/api/automation/rules/${storeId}`),

  createAutomationRule: (input: {
    storeId: string;
    triggerType: AutomationRule['triggerType'];
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

  deleteAutomationRule: (ruleId: string, storeId: string) =>
    request<{ ok: true }>(`/api/automation/rules/${ruleId}`, {
      method: 'DELETE',
      body: { storeId },
    }),

  jobs: (storeId: string, status?: string) =>
    request<JobsResponse>(`/api/jobs/${storeId}`, { query: { status } }),

  chat: async (storeId: string, message: string): Promise<ChatResponse> => {
    const sessionRes = await request<{ token: string; conversationId: string }>('/api/session', {
      method: 'POST',
      body: { storeId },
    });
    return request<ChatResponse>('/api/chat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionRes.token}` },
      body: { message },
    });
  },

  attributionClick: (token: string, productId: string) =>
    request<{ ok: true }>('/api/attributions/click', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { productId },
    }),
};

export function isPaymentRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 402;
}