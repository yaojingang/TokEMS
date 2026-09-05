CREATE TABLE "refund_merchant_schedules" (
	"merchant_id" varchar(32) PRIMARY KEY NOT NULL,
	"next_submit_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_notification_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"merchant_id" varchar(32) NOT NULL,
	"notification_id" varchar(128) NOT NULL,
	"out_refund_no" varchar(64) NOT NULL,
	"status" varchar(24) DEFAULT 'received' NOT NULL,
	"payload" jsonb NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"source" varchar(24) NOT NULL,
	"customer_user_id" uuid,
	"requested_by" uuid,
	"reviewed_by" uuid,
	"amount" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"reserved_amount" integer NOT NULL,
	"completed_amount" integer DEFAULT 0 NOT NULL,
	"review_status" varchar(24) DEFAULT 'pending_review' NOT NULL,
	"fulfillment_status" varchar(24),
	"reason" text DEFAULT '' NOT NULL,
	"review_reason" text,
	"policy_snapshot" jsonb NOT NULL,
	"business_snapshot" jsonb NOT NULL,
	"idempotency_key" varchar(64) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"reviewed_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	"attention_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_requests_amount_check" CHECK ("refund_requests"."amount" > 0 and "refund_requests"."reserved_amount" >= 0 and "refund_requests"."completed_amount" >= 0 and "refund_requests"."reserved_amount" + "refund_requests"."completed_amount" <= "refund_requests"."amount")
);
--> statement-breakpoint
ALTER TABLE "refunds" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refund_execution_mode" varchar(24) DEFAULT 'automatic' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refund_execution_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refund_execution_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "merchant_id" varchar(32);--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "source" varchar(24) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "merchant_id" varchar(32);--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "out_refund_no" varchar(64);--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "provider_refund_id" varchar(64);--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "channel_status" varchar(24);--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "recipient_kind" varchar(24);--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "payer_refund" integer;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "request_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "succeeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "last_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "lease_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "last_error_code" varchar(80);--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "current_attempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "fulfillment_attention" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "refund_paused_by" uuid;--> statement-breakpoint
ALTER TABLE "refund_notification_inbox" ADD CONSTRAINT "refund_notification_inbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_customer_user_id_customer_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."customer_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_inbox_notification_unique" ON "refund_notification_inbox" USING btree ("organization_id","merchant_id","notification_id");--> statement-breakpoint
CREATE INDEX "refund_inbox_due_idx" ON "refund_notification_inbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_requests_active_order_unique" ON "refund_requests" USING btree ("order_id") WHERE "refund_requests"."terminated_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_requests_idempotency_unique" ON "refund_requests" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "refund_requests_event_review_idx" ON "refund_requests" USING btree ("organization_id","event_id","review_status","created_at");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_refund_execution_updated_by_users_id_fk" FOREIGN KEY ("refund_execution_updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_request_id_refund_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."refund_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_refund_paused_by_refund_requests_id_fk" FOREIGN KEY ("refund_paused_by") REFERENCES "public"."refund_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_merchant_out_refund_unique" ON "refunds" USING btree ("merchant_id","out_refund_no");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_merchant_provider_refund_unique" ON "refunds" USING btree ("merchant_id","provider_refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_current_request_unique" ON "refunds" USING btree ("request_id") WHERE "refunds"."current_attempt" = true;--> statement-breakpoint
CREATE INDEX "refunds_due_idx" ON "refunds" USING btree ("next_attempt_at") WHERE "refunds"."request_id" is not null;