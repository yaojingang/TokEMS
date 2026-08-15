UPDATE "attendee_showcase_profiles"
SET "qualified_at" = "created_at"
WHERE "qualified_at" IS NULL;--> statement-breakpoint
ALTER TABLE "attendee_showcase_profiles" ALTER COLUMN "qualified_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_media_assets" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_media_assets" ADD COLUMN "source_deleted_at" timestamp with time zone;
