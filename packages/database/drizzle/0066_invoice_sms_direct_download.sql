CREATE TABLE "invoice_document_access_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" integer,
	"order_id" uuid,
	"invoice_request_id" uuid,
	"invoice_document_id" uuid,
	"document_identity" text,
	"purpose" varchar(32) NOT NULL,
	"recipient_hash" varchar(64) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"sealed_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_file_access_scope" CHECK ((
    "invoice_document_access_links"."purpose" = 'invoice' and "invoice_document_access_links"."event_id" is not null and "invoice_document_access_links"."order_id" is not null
    and "invoice_document_access_links"."invoice_request_id" is not null and "invoice_document_access_links"."invoice_document_id" is not null and "invoice_document_access_links"."document_identity" is not null
  ) or (
    "invoice_document_access_links"."purpose" = 'test' and "invoice_document_access_links"."event_id" is null and "invoice_document_access_links"."order_id" is null
    and "invoice_document_access_links"."invoice_request_id" is null and "invoice_document_access_links"."invoice_document_id" is null and "invoice_document_access_links"."document_identity" is null
  ))
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "invoice_request_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "invoice_document_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "document_identity" text;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "file_access_link_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "business_key" varchar(240);--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "activation_revision" integer;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "purpose" varchar(32);--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "recipient_source" varchar(40);--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "configuration_fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "file_reachable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "send_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_document_access_links" ADD CONSTRAINT "invoice_document_access_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_document_access_links" ADD CONSTRAINT "invoice_document_access_links_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_document_access_links" ADD CONSTRAINT "invoice_document_access_links_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_document_access_links" ADD CONSTRAINT "invoice_document_access_links_invoice_request_id_invoice_requests_id_fk" FOREIGN KEY ("invoice_request_id") REFERENCES "public"."invoice_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_document_access_links" ADD CONSTRAINT "invoice_document_access_links_invoice_document_id_invoice_documents_id_fk" FOREIGN KEY ("invoice_document_id") REFERENCES "public"."invoice_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_file_access_token_unique" ON "invoice_document_access_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invoice_file_access_invoice_idx" ON "invoice_document_access_links" USING btree ("invoice_request_id","created_at");--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_invoice_request_id_invoice_requests_id_fk" FOREIGN KEY ("invoice_request_id") REFERENCES "public"."invoice_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_invoice_document_id_invoice_documents_id_fk" FOREIGN KEY ("invoice_document_id") REFERENCES "public"."invoice_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_file_access_link_id_invoice_document_access_links_id_fk" FOREIGN KEY ("file_access_link_id") REFERENCES "public"."invoice_document_access_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_business_key_unique" ON "notification_deliveries" USING btree ("business_key");--> statement-breakpoint
CREATE INDEX "notification_delivery_invoice_idx" ON "notification_deliveries" USING btree ("invoice_request_id","created_at");
--> statement-breakpoint
-- The legacy account-link template is not authorization for anonymous invoice-file delivery.
UPDATE organization_integrations
SET config = jsonb_set(
  jsonb_set(config, '{templates}', coalesce(config->'templates', '{}'::jsonb) ||
    jsonb_build_object('invoiceReady', coalesce(config#>'{templates,invoiceReady}', '{}'::jsonb) || '{"enabled":false}'::jsonb)),
  '{invoiceSms}', '{"deliveryMode":"legacy","activationRevision":0}'::jsonb), updated_at=now()
WHERE provider='aliyun-sms';
--> statement-breakpoint
UPDATE order_access_tokens SET revoked_at=now()
WHERE id IN (SELECT access_token_id FROM notification_deliveries
  WHERE purpose IS NULL AND subject LIKE '%电子发票已开具' AND status IN ('queued','retrying','claimed'))
  AND revoked_at IS NULL;
--> statement-breakpoint
UPDATE notification_deliveries SET status='cancelled',sealed_access_token=NULL,
  error='旧发票交付任务已退休，请使用发票短信补发',updated_at=now()
WHERE purpose IS NULL AND subject LIKE '%电子发票已开具' AND status IN ('queued','retrying','claimed');
