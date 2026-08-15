ALTER TABLE "payments" ADD COLUMN "succeeded_at" timestamp with time zone;--> statement-breakpoint
UPDATE "payments"
SET "succeeded_at" = "updated_at"
WHERE "status" IN ('succeeded', 'refunded') AND "succeeded_at" IS NULL;--> statement-breakpoint
UPDATE "events"
SET "settings" = jsonb_set(
  "settings",
  '{registration}',
  coalesce("settings"->'registration', '{}'::jsonb) || '{"accountMode":"mobile_otp_required"}'::jsonb,
  true
)
WHERE coalesce("settings"->'registration'->>'accountMode', '') <> 'mobile_otp_required';--> statement-breakpoint
UPDATE "organizations"
SET "settings" = jsonb_set(
  "settings",
  '{customerAccounts}',
  coalesce("settings"->'customerAccounts', '{}'::jsonb) || '{"defaultAccountMode":"mobile_otp_required"}'::jsonb,
  true
)
WHERE coalesce("settings"->'customerAccounts'->>'defaultAccountMode', '') <> 'mobile_otp_required';--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "superseded_by_registration_id" uuid;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_superseded_by_registration_id_registrations_id_fk" FOREIGN KEY ("superseded_by_registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "registrations_superseded_idx" ON "registrations" USING btree ("event_id","superseded_at");
