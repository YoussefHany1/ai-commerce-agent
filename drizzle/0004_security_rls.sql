CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "platform_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "variants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "automation_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "automation_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attributions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "whatsapp_channels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "daily_metrics" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_stores" ON "stores"
USING (current_setting('app.operator', true) = 'true')
WITH CHECK (current_setting('app.operator', true) = 'true');
--> statement-breakpoint
CREATE POLICY "tenant_operator_stores" ON "stores"
USING (current_setting('app.operator', true) = 'true')
WITH CHECK (current_setting('app.operator', true) = 'true');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_whatsapp_channels" ON "whatsapp_channels"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_operator_whatsapp_channels" ON "whatsapp_channels"
USING (current_setting('app.operator', true) = 'true')
WITH CHECK (current_setting('app.operator', true) = 'true');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_billing_subscriptions" ON "billing_subscriptions"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_operator_billing_subscriptions" ON "billing_subscriptions"
USING (current_setting('app.operator', true) = 'true')
WITH CHECK (current_setting('app.operator', true) = 'true');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_jobs" ON "jobs"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_operator_jobs" ON "jobs"
USING (current_setting('app.operator', true) = 'true')
WITH CHECK (current_setting('app.operator', true) = 'true');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_automation_rules" ON "automation_rules"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_operator_automation_rules" ON "automation_rules"
USING (current_setting('app.operator', true) = 'true')
WITH CHECK (current_setting('app.operator', true) = 'true');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_automation_logs" ON "automation_logs"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_operator_automation_logs" ON "automation_logs"
USING (current_setting('app.operator', true) = 'true')
WITH CHECK (current_setting('app.operator', true) = 'true');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_platform_connections" ON "platform_connections"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation_products" ON "products"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation_variants" ON "variants"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation_customers" ON "customers"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation_orders" ON "orders"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation_conversations" ON "conversations"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation_messages" ON "messages"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation_events" ON "events"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation_attributions" ON "attributions"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation_daily_metrics" ON "daily_metrics"
USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);