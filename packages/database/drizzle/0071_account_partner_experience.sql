ALTER TABLE "customer_auth_challenges" ADD COLUMN "consent_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "customer_auth_challenges" ADD COLUMN "consent_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_partner_profile_versions" ADD COLUMN "poster_copy" jsonb DEFAULT '{"invitation":"","introduction":""}'::jsonb NOT NULL;