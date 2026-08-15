CREATE TABLE "attendee_claim_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"mobile_digest" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "purchaser_customer_user_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "purchaser_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "purchase_intent_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "settings" SET DEFAULT '{"locale":"zh-CN","registration":{"paymentMode":"ticketed","currency":"CNY","registrationOpen":true,"accountMode":"mobile_otp_required","additionalPurchaseEnabled":false,"maxActiveSeatsPerPurchaser":5}}'::jsonb;--> statement-breakpoint
UPDATE orders
SET
	purchaser_customer_user_id = registrations.customer_user_id,
	purchaser_snapshot = jsonb_build_object(
		'customerUserId', registrations.customer_user_id,
		'mobile', coalesce(customer_users.mobile_e164, registrations.attendee ->> 'mobile', ''),
		'name', coalesce(nullif(customer_profiles.real_name, ''), nullif(customer_profiles.nickname, ''), registrations.attendee ->> 'name', ''),
		'email', coalesce(nullif(customer_profiles.email, ''), registrations.attendee ->> 'email', ''),
		'company', coalesce(nullif(customer_profiles.company, ''), registrations.attendee ->> 'company', ''),
		'title', coalesce(nullif(customer_profiles.title, ''), registrations.attendee ->> 'title', ''),
		'city', coalesce(nullif(customer_profiles.city, ''), registrations.attendee ->> 'city', '')
	)
FROM registrations
LEFT JOIN customer_users ON customer_users.id = registrations.customer_user_id
LEFT JOIN customer_profiles ON customer_profiles.customer_user_id = registrations.customer_user_id
WHERE orders.registration_id = registrations.id;--> statement-breakpoint
ALTER TABLE "attendee_claim_tokens" ADD CONSTRAINT "attendee_claim_tokens_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendee_claim_tokens_hash_unique" ON "attendee_claim_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "attendee_claim_tokens_registration_time_idx" ON "attendee_claim_tokens" USING btree ("registration_id","created_at");--> statement-breakpoint
CREATE INDEX "attendee_claim_tokens_active_expiry_idx" ON "attendee_claim_tokens" USING btree ("expires_at") WHERE "attendee_claim_tokens"."consumed_at" is null and "attendee_claim_tokens"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_purchaser_customer_user_id_customer_users_id_fk" FOREIGN KEY ("purchaser_customer_user_id") REFERENCES "public"."customer_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_purchaser_customer_org_fk" FOREIGN KEY ("purchaser_customer_user_id","organization_id") REFERENCES "public"."customer_users"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_purchaser_time_idx" ON "orders" USING btree ("purchaser_customer_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_purchaser_intent_unique" ON "orders" USING btree ("organization_id","event_id","purchaser_customer_user_id","purchase_intent_id") WHERE "orders"."purchaser_customer_user_id" is not null and "orders"."purchase_intent_id" is not null;
