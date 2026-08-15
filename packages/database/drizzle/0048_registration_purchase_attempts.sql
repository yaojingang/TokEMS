CREATE TABLE "registration_purchase_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"purchaser_customer_user_id" uuid NOT NULL,
	"purchase_intent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registration_purchase_attempts" ADD CONSTRAINT "registration_purchase_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_purchase_attempts" ADD CONSTRAINT "registration_purchase_attempts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_purchase_attempts" ADD CONSTRAINT "registration_purchase_attempts_purchaser_org_fk" FOREIGN KEY ("purchaser_customer_user_id","organization_id") REFERENCES "public"."customer_users"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_id_org_unique" ON "events" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "registration_purchase_attempts" ADD CONSTRAINT "registration_purchase_attempts_event_org_fk" FOREIGN KEY ("event_id","organization_id") REFERENCES "public"."events"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "registration_purchase_attempts_purchaser_time_idx" ON "registration_purchase_attempts" USING btree ("organization_id","event_id","purchaser_customer_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_purchase_attempts_intent_unique" ON "registration_purchase_attempts" USING btree ("organization_id","event_id","purchaser_customer_user_id","purchase_intent_id");
