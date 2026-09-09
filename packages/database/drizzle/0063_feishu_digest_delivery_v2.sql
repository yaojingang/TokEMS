ALTER TABLE "event_feishu_digest_subscriptions" ADD COLUMN "config_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_feishu_digest_subscriptions" ADD COLUMN "test_verified_connection_version" integer;--> statement-breakpoint
ALTER TABLE "event_feishu_digest_subscriptions" ADD COLUMN "pause_reason" varchar(120);--> statement-breakpoint
ALTER TABLE "feishu_digest_deliveries" ADD COLUMN "card_payload" jsonb;--> statement-breakpoint
ALTER TABLE "feishu_digest_deliveries" ADD COLUMN "connection_version" integer;--> statement-breakpoint
ALTER TABLE "feishu_digest_deliveries" ADD COLUMN "subscription_config_version" integer;--> statement-breakpoint
ALTER TABLE "feishu_digest_deliveries" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "feishu_digest_deliveries" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feishu_digest_deliveries" ADD COLUMN "first_send_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feishu_digest_deliveries" ADD COLUMN "resolution" jsonb;--> statement-breakpoint
-- Existing subscriptions require a V2 test before automatic sending resumes.
UPDATE "event_feishu_digest_subscriptions"
SET "enabled" = false, "next_run_at" = null, "test_verified_at" = null,
    "test_verified_chat_id" = null, "pause_reason" = 'upgrade_requires_test',
    "config_version" = "config_version" + 1, "updated_at" = now();
--> statement-breakpoint
-- This is an observation upper bound, never a fabricated refund success date.
UPDATE "refunds"
SET "provider_payload" = "provider_payload" || jsonb_build_object('digestSuccessObservedAt', now())
WHERE "status" = 'succeeded' AND "succeeded_at" IS NULL
  AND NOT ("provider_payload" ? 'digestSuccessObservedAt');
