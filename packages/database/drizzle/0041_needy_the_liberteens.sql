CREATE TABLE "event_slug_aliases" (
	"organization_id" uuid NOT NULL,
	"slug" varchar(100) NOT NULL,
	"event_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_slug_aliases_organization_id_slug_pk" PRIMARY KEY("organization_id","slug")
);
--> statement-breakpoint
ALTER TABLE "event_slug_aliases" ADD CONSTRAINT "event_slug_aliases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_slug_aliases" ADD CONSTRAINT "event_slug_aliases_event_scope_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_slug_aliases_event_idx" ON "event_slug_aliases" USING btree ("event_id");