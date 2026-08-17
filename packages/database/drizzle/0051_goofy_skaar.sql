CREATE TABLE "event_public_metrics" (
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"page_views" bigint DEFAULT 0 NOT NULL,
	"tracking_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_public_metrics_organization_id_event_id_pk" PRIMARY KEY("organization_id","event_id"),
	CONSTRAINT "event_public_metrics_page_views_nonnegative" CHECK ("event_public_metrics"."page_views" >= 0)
);
--> statement-breakpoint
ALTER TABLE "event_public_metrics" ADD CONSTRAINT "event_public_metrics_event_scope_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."events"("organization_id","id") ON DELETE cascade ON UPDATE no action;