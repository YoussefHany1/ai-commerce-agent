CREATE TABLE "automation_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"rule_id" uuid,
	"trigger_type" text NOT NULL,
	"conversation_id" uuid,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"body" text,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"day" date NOT NULL,
	"orders" integer DEFAULT 0 NOT NULL,
	"revenue" double precision DEFAULT 0 NOT NULL,
	"attributed_revenue" double precision DEFAULT 0 NOT NULL,
	"conversations" integer DEFAULT 0 NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"recommended" integer DEFAULT 0 NOT NULL,
	"clicked" integer DEFAULT 0 NOT NULL,
	"converted" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attributions" ADD COLUMN "channel" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "attributions" ADD COLUMN "createdAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "attributions" ADD COLUMN "revenue" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "cooldown_minutes" integer DEFAULT 1440 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "lookback_hours" integer DEFAULT 72 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "last_fired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_logs_rule_conv_uidx" ON "automation_logs" USING btree ("store_id","rule_id","conversation_id");--> statement-breakpoint
CREATE INDEX "automation_logs_store_id_idx" ON "automation_logs" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_metrics_store_day_uidx" ON "daily_metrics" USING btree ("store_id","day");--> statement-breakpoint
CREATE INDEX "daily_metrics_store_id_idx" ON "daily_metrics" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "attributions_store_id_idx" ON "attributions" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "attributions_conv_idx" ON "attributions" USING btree ("conversation_id","product_id");