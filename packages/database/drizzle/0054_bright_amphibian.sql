CREATE TABLE "event_feishu_digest_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"digest_type" varchar(40) DEFAULT 'daily_operations' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"chat_id" varchar(160),
	"chat_name_snapshot" varchar(200),
	"send_local_time" varchar(5) DEFAULT '09:00' NOT NULL,
	"timezone_snapshot" varchar(80) NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_successful_at" timestamp with time zone,
	"test_verified_at" timestamp with time zone,
	"test_verified_chat_id" varchar(160),
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_feishu_digest_subscriptions_type_check" CHECK ("event_feishu_digest_subscriptions"."digest_type" in ('daily_operations')),
	CONSTRAINT "event_feishu_digest_subscriptions_time_check" CHECK ("event_feishu_digest_subscriptions"."send_local_time" ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
CREATE TABLE "event_public_metric_days" (
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"local_date" date NOT NULL,
	"page_views" bigint DEFAULT 0 NOT NULL,
	"timezone_snapshot" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_public_metric_days_organization_id_event_id_local_date_pk" PRIMARY KEY("organization_id","event_id","local_date"),
	CONSTRAINT "event_public_metric_days_page_views_nonnegative" CHECK ("event_public_metric_days"."page_views" >= 0)
);
--> statement-breakpoint
CREATE TABLE "feishu_digest_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid,
	"source_delivery_id" uuid,
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"kind" varchar(24) NOT NULL,
	"report_date" date NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"generated_at" timestamp with time zone,
	"aggregate_snapshot" jsonb,
	"card_digest" varchar(64),
	"chat_id_snapshot" varchar(160) NOT NULL,
	"chat_name_snapshot" varchar(200) NOT NULL,
	"status" varchar(24) DEFAULT 'queued' NOT NULL,
	"provider_message_id" varchar(160),
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(80),
	"last_error" text,
	"dedup_key" varchar(240) NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_digest_deliveries_kind_check" CHECK ("feishu_digest_deliveries"."kind" in ('scheduled', 'manual_test', 'manual_resend')),
	CONSTRAINT "feishu_digest_deliveries_status_check" CHECK ("feishu_digest_deliveries"."status" in ('queued', 'generating', 'sending', 'retrying', 'sent', 'unknown', 'failed', 'skipped', 'cancelled')),
	CONSTRAINT "feishu_digest_deliveries_attempts_nonnegative" CHECK ("feishu_digest_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "event_public_metrics" ADD COLUMN "daily_tracking_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_feishu_digest_subscriptions" ADD CONSTRAINT "event_feishu_digest_subscriptions_event_scope_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_public_metric_days" ADD CONSTRAINT "event_public_metric_days_event_scope_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_digest_deliveries" ADD CONSTRAINT "feishu_digest_deliveries_subscription_id_event_feishu_digest_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."event_feishu_digest_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_digest_deliveries" ADD CONSTRAINT "feishu_digest_deliveries_source_delivery_id_feishu_digest_deliveries_id_fk" FOREIGN KEY ("source_delivery_id") REFERENCES "public"."feishu_digest_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_digest_deliveries" ADD CONSTRAINT "feishu_digest_deliveries_event_scope_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_feishu_digest_subscriptions_scope_unique" ON "event_feishu_digest_subscriptions" USING btree ("organization_id","event_id","digest_type");--> statement-breakpoint
CREATE INDEX "event_feishu_digest_subscriptions_due_idx" ON "event_feishu_digest_subscriptions" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_digest_deliveries_dedup_unique" ON "feishu_digest_deliveries" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "feishu_digest_deliveries_event_time_idx" ON "feishu_digest_deliveries" USING btree ("organization_id","event_id","created_at");--> statement-breakpoint
CREATE INDEX "feishu_digest_deliveries_status_time_idx" ON "feishu_digest_deliveries" USING btree ("status","updated_at");
