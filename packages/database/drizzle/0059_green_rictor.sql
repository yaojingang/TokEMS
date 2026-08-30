DROP INDEX "template_assets_org_digest_unique";--> statement-breakpoint
ALTER TABLE "template_assets" ADD COLUMN "purpose" varchar(40) DEFAULT 'template' NOT NULL;--> statement-breakpoint
UPDATE "template_assets"
SET "purpose" = 'attendee_service_qr'
WHERE "id" IN (
	SELECT "organizer_qr_asset_id"
	FROM "event_attendee_service_configs"
	WHERE "organizer_qr_asset_id" IS NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "template_assets_org_digest_purpose_unique" ON "template_assets" USING btree ("organization_id","content_digest","purpose");--> statement-breakpoint
ALTER TABLE "template_assets" ADD CONSTRAINT "template_assets_purpose" CHECK ("template_assets"."purpose" in ('template', 'attendee_service_qr'));
