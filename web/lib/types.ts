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

export interface ApiErrorBody {
  error?: string;
  message?: string;
  planStatus?: string;
}