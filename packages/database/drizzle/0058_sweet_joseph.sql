CREATE TABLE "event_attendee_service_configs" (
	"event_id" integer PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"organizer_name" varchar(120) DEFAULT '' NOT NULL,
	"organizer_role" varchar(160) DEFAULT '' NOT NULL,
	"wechat_id" varchar(80) DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"organizer_qr_asset_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_attendee_service_configs_version_positive" CHECK ("event_attendee_service_configs"."version" > 0),
	CONSTRAINT "event_attendee_service_configs_enabled_content" CHECK ("event_attendee_service_configs"."enabled" = false or (
        length(trim("event_attendee_service_configs"."organizer_name")) > 0
        and length(trim("event_attendee_service_configs"."wechat_id")) > 0
        and length(trim("event_attendee_service_configs"."instructions")) > 0
        and "event_attendee_service_configs"."organizer_qr_asset_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "registration_service_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"registration_id" uuid NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"action_code" varchar(80) NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_service_acknowledgements_action_code" CHECK ("registration_service_acknowledgements"."action_code" = 'organizer_contact_confirmed')
);
--> statement-breakpoint
ALTER TABLE "event_attendee_service_configs" ADD CONSTRAINT "event_attendee_service_configs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendee_service_configs" ADD CONSTRAINT "event_attendee_service_configs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendee_service_configs" ADD CONSTRAINT "event_attendee_service_configs_organizer_qr_asset_id_template_assets_id_fk" FOREIGN KEY ("organizer_qr_asset_id") REFERENCES "public"."template_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendee_service_configs" ADD CONSTRAINT "event_attendee_service_configs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendee_service_configs" ADD CONSTRAINT "event_attendee_service_configs_event_scope_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_service_acknowledgements" ADD CONSTRAINT "registration_service_acknowledgements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_service_acknowledgements" ADD CONSTRAINT "registration_service_acknowledgements_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_service_acknowledgements" ADD CONSTRAINT "registration_service_acknowledgements_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_service_acknowledgements" ADD CONSTRAINT "registration_service_acknowledgements_customer_user_id_customer_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."customer_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_service_acknowledgements" ADD CONSTRAINT "registration_service_acknowledgements_registration_scope_fk" FOREIGN KEY ("registration_id","organization_id","event_id") REFERENCES "public"."registrations"("id","organization_id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_service_acknowledgements" ADD CONSTRAINT "registration_service_acknowledgements_customer_org_fk" FOREIGN KEY ("customer_user_id","organization_id") REFERENCES "public"."customer_users"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_attendee_service_configs_org_idx" ON "event_attendee_service_configs" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_service_acknowledgements_action_unique" ON "registration_service_acknowledgements" USING btree ("registration_id","action_code");--> statement-breakpoint
CREATE INDEX "registration_service_acknowledgements_customer_idx" ON "registration_service_acknowledgements" USING btree ("customer_user_id","completed_at");