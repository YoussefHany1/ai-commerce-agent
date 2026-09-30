export type Platform = 'shopify' | 'salla' | 'zid';

export type PlanStatus = 'trial' | 'active' | 'expired' | 'free';

export interface Store {
  id: string;
  name: string;
  platform: Platform;
  shopDomain: string | null;
  planStatus: string | null;
  createdAt: string;
}

export interface DailyMetricRow {
  day: string;
  orders: number;
  revenue: number;
  attributedRevenue: number;
  conversations: number;
  messages: number;
  recommended: number;
  clicked: number;
  converted: number;
}

export interface MetricsTotals {
  orders: number;
  revenue: number;
  attributedRevenue: number;
  conversations: number;
  messages: number;
  recommended: number;
  clicked: number;
  converted: number;
}

export interface MetricsResponse {
  storeId: string;
  days: DailyMetricRow[];
  totals: MetricsTotals;
}

export type AttributionStatus = 'recommended' | 'clicked' | 'converted';

export interface AttributionRow {
  channel: string;
  productId: string;
  productTitle: string;
  productPrice: number;
  status: AttributionStatus;
  clickedAt: string | null;
  convertedAt: string | null;
  revenue: number;
}

export interface AttributionsResponse {
  storeId: string;
  count: number;
  attributions: AttributionRow[];
}

export interface ChannelFunnel {
  channel: string;
  recommended: number;
  clicked: number;
  converted: number;
  revenue: number;
  ctr: number;
  cvr: number;
  avgConversionLagHours: number;
}

export interface SourcesResponse {
  storeId: string;
  channels: ChannelFunnel[];
}

export interface TopProduct {
  productId: string;
  productTitle: string;
  productPrice: number;
  recommended: number;
  clicked: number;
  converted: number;
  revenue: number;
  cvr: number;
}

export interface TopProductsResponse {
  storeId: string;
  products: TopProduct[];
}

export interface LagSummary {
  count: number;
  avgHours: number;
  medianHours: number;
  p90Hours: number;
}

export interface LagBucket {
  label: string;
  count: number;
  share: number;
}

export interface ConversionLagResponse {
  storeId: string;
  range: { from: string; days: number };
  overall: LagSummary;
  daily: Array<{ day: string; conversions: number; avgHours: number }>;
  distribution: LagBucket[];
}

export interface BillingStatus {
  storeId: string;
  planStatus: string;
  plan: string;
  status: string | null;
  currentPeriodEnd: string | null;
  stripeCustomerId: string | null;
}

export interface CheckoutResponse {
  url: string;
  sessionId: string;
}

export interface AutomationAction {
  type: 'whatsapp_text';
  text: string;
}

export type AutomationTriggerType = 'clicked_no_conversion' | 'inactive_conversation';

export interface AutomationRule {
  id: string;
  storeId: string;
  triggerType: AutomationTriggerType;
  action: AutomationAction;
  enabled: boolean;
  cooldownMinutes: number;
  lookbackHours: number;
  lastFiredAt: string | null;
  createdAt: string;
}

export interface AutomationRulesResponse {
  storeId: string;
  rules: AutomationRule[];
}

export interface Job {
  id: string;
  type: string;
  status: string;
  attempts: number;
  lastError: string | null;
  runAt: string | null;
  createdAt: string;
}

export interface JobsResponse {
  storeId: string;
  jobs: Job[];
}

export interface HealthResponse {
  ok: boolean;
  deps: { db: boolean; redis: boolean; rls: boolean };
  time: string;
}

/**
 * The account behind the current cookie, per `/api/auth/session`.
 *
 * A client is a tenant account: an invited merchant with a name and contact the
 * dashboard shell shows instead of a store name. An operator is a named person who
 * runs the install, so it reports who is signed in rather than merely that somebody
 * is — an operator session is a person's identity now, not a shared password, and the
 * UI needs it to label actions and to know whether it may manage other operators.
 */
export type SessionInfo =
  | {
      authenticated: true;
      kind: 'operator';
      operatorId: string;
      /** Null on a cookie minted before a rename reached this install. */
      name: string | null;
      email: string | null;
    }
  | {
      authenticated: true;
      kind: 'client';
      clientId: string;
      name: string | null;
      email: string | null;
    }
  | { authenticated: false };

export interface ClientAccount {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'suspended';
  createdAt: string;
  updatedAt: string;
  storeCount: number;
}

export interface ClientCreateResult extends ClientAccount {
  /** Shown exactly once by the operator; the invite holder must change it. */
  temporaryPassword?: string;
}

export interface ChatResponse {
  reply: string;
  products: Array<{
    id: string;
    title: string;
    description?: string;
    price: number;
    currency: string;
    available: boolean;
    url?: string;
    sku?: string;
  }>;
}

/**
 * A chat turn plus the guest session token it was made with.
 *
 * The token has to travel back to the caller because it is also the credential
 * `POST /api/attributions/click` wants. Without it a recommendation rendered
 * here could never be attributed, and the Analytics page stays empty no matter
 * how much chatting happens on this screen.
 */
export interface ChatResult extends ChatResponse {
  token: string;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
  planStatus?: string;
}