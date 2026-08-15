CREATE TABLE "attendee_showcase_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"registration_id" uuid NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"public_slug" varchar(32) NOT NULL,
	"qualified_at" timestamp with time zone,
	"sequence" integer NOT NULL,
	"display_name" varchar(120),
	"company" varchar(160),
	"title" varchar(100),
	"industry_code" varchar(48),
	"business_intro" text,
	"business_url" varchar(500),
	"contact_phone" varchar(40),
	"contact_email" varchar(255),
	"wechat_id" varchar(80),
	"avatar_asset_id" uuid,
	"is_public" boolean DEFAULT false NOT NULL,
	"visible_fields" jsonb DEFAULT '{"avatar":true,"displayName":true,"company":true,"title":true,"industry":true,"businessIntro":true,"businessUrl":true,"contactPhone":false,"contactEmail":false,"wechatId":false}'::jsonb NOT NULL,
	"consent_version" varchar(40),
	"consent_at" timestamp with time zone,
	"admin_hidden_at" timestamp with time zone,
	"admin_hidden_reason" varchar(500),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendee_showcases_sequence_positive" CHECK ("attendee_showcase_profiles"."sequence" > 0),
	CONSTRAINT "attendee_showcases_version_positive" CHECK ("attendee_showcase_profiles"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "customer_media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"kind" varchar(32) DEFAULT 'avatar' NOT NULL,
	"source_storage_key" varchar(500) NOT NULL,
	"output_storage_key" varchar(500),
	"media_type" varchar(80) NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"content_digest" varchar(64) NOT NULL,
	"status" varchar(24) DEFAULT 'processing' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_media_assets_kind_check" CHECK ("customer_media_assets"."kind" in ('avatar')),
	CONSTRAINT "customer_media_assets_status_check" CHECK ("customer_media_assets"."status" in ('processing', 'ready', 'failed')),
	CONSTRAINT "customer_media_assets_size_check" CHECK ("customer_media_assets"."size" between 1 and 5242880)
);
--> statement-breakpoint
ALTER TABLE "attendee_showcase_profiles" ADD CONSTRAINT "attendee_showcase_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_showcase_profiles" ADD CONSTRAINT "attendee_showcase_profiles_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_showcase_profiles" ADD CONSTRAINT "attendee_showcase_profiles_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_showcase_profiles" ADD CONSTRAINT "attendee_showcase_profiles_customer_user_id_customer_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."customer_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_showcase_profiles" ADD CONSTRAINT "attendee_showcase_profiles_avatar_asset_id_customer_media_assets_id_fk" FOREIGN KEY ("avatar_asset_id") REFERENCES "public"."customer_media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_showcase_profiles" ADD CONSTRAINT "attendee_showcases_registration_scope_fk" FOREIGN KEY ("registration_id","organization_id","event_id") REFERENCES "public"."registrations"("id","organization_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_showcase_profiles" ADD CONSTRAINT "attendee_showcases_customer_org_fk" FOREIGN KEY ("customer_user_id","organization_id") REFERENCES "public"."customer_users"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_media_assets" ADD CONSTRAINT "customer_media_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_media_assets" ADD CONSTRAINT "customer_media_assets_customer_user_id_customer_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."customer_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_media_assets" ADD CONSTRAINT "customer_media_assets_customer_org_fk" FOREIGN KEY ("customer_user_id","organization_id") REFERENCES "public"."customer_users"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendee_showcases_registration_unique" ON "attendee_showcase_profiles" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendee_showcases_public_slug_unique" ON "attendee_showcase_profiles" USING btree ("public_slug");--> statement-breakpoint
CREATE INDEX "attendee_showcases_public_list_idx" ON "attendee_showcase_profiles" USING btree ("event_id","is_public","admin_hidden_at","qualified_at","registration_id");--> statement-breakpoint
CREATE INDEX "attendee_showcases_industry_idx" ON "attendee_showcase_profiles" USING btree ("event_id","industry_code","qualified_at","registration_id");--> statement-breakpoint
CREATE INDEX "attendee_showcases_customer_idx" ON "attendee_showcase_profiles" USING btree ("customer_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "customer_media_assets_owner_time_idx" ON "customer_media_assets" USING btree ("organization_id","customer_user_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_media_assets_status_idx" ON "customer_media_assets" USING btree ("status","updated_at");