CREATE UNIQUE INDEX "events_org_id_unique" ON "events" USING btree ("organization_id","id");
--> statement-breakpoint
CREATE TABLE "organization_homepage_events" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_homepage_events" ADD CONSTRAINT "organization_homepage_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "organization_homepage_events" ADD CONSTRAINT "organization_homepage_events_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "organization_homepage_events" ADD CONSTRAINT "organization_homepage_events_event_scope_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."events"("organization_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "organization_homepage_events_event_idx" ON "organization_homepage_events" USING btree ("event_id");
