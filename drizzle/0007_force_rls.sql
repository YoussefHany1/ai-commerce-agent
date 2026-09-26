-- 0004 enabled RLS on all 16 tables but never FORCEd it, and a table owner
-- bypasses RLS by default. That left the whole policy set as opt-in: if
-- DATABASE_URL ever pointed at the owner/superuser connection rather than the
-- restricted agent_app role, every one of the 33 policies in 0004/0006 was
-- silently ignored with no error, and src/config.ts defaulted DATABASE_URL to
-- postgres:postgres@localhost, so a production deploy that forgot to set it got
-- exactly that.
--
-- FORCE closes it. Note the deliberate trade-off: FORCE also subjects the owner
-- to RLS, so DML run as the owner now needs the same app.store_id / app.operator
-- settings the app sets. scripts/rotate-key.ts sets app.operator for this reason
-- (migrate.ts and apply-rls.ts are DDL-only and are unaffected). The runtime role
-- in docker-compose.yml and render.yaml is already a non-owner, so its behaviour
-- is unchanged.
ALTER TABLE "stores" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "platform_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "variants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "automation_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "automation_logs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attributions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "whatsapp_channels" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "daily_metrics" FORCE ROW LEVEL SECURITY;
