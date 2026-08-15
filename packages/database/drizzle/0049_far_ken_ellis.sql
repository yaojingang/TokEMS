ALTER TABLE "notification_deliveries" ADD COLUMN "access_token_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "sealed_access_token" text;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "access_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_access_token_id_order_access_tokens_id_fk" FOREIGN KEY ("access_token_id") REFERENCES "public"."order_access_tokens"("id") ON DELETE set null ON UPDATE no action;