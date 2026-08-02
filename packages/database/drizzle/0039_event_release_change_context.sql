ALTER TABLE "event_releases" ADD COLUMN "change_summary" text DEFAULT '历史发布版本' NOT NULL;
--> statement-breakpoint
ALTER TABLE "event_releases" ADD COLUMN "change_scope" varchar(32) DEFAULT 'site' NOT NULL;
--> statement-breakpoint
ALTER TABLE "event_releases" ADD COLUMN "activation_kind" varchar(16) DEFAULT 'manual' NOT NULL;
