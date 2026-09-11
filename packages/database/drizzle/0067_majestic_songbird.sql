ALTER TABLE "invoice_document_access_links" DROP CONSTRAINT "invoice_file_access_scope";--> statement-breakpoint
ALTER TABLE "invoice_document_access_links" ADD CONSTRAINT "invoice_file_access_scope" CHECK ((
    "invoice_document_access_links"."purpose" in ('invoice', 'account') and "invoice_document_access_links"."event_id" is not null and "invoice_document_access_links"."order_id" is not null
    and "invoice_document_access_links"."invoice_request_id" is not null and "invoice_document_access_links"."invoice_document_id" is not null and "invoice_document_access_links"."document_identity" is not null
  ) or (
    "invoice_document_access_links"."purpose" = 'test' and "invoice_document_access_links"."event_id" is null and "invoice_document_access_links"."order_id" is null
    and "invoice_document_access_links"."invoice_request_id" is null and "invoice_document_access_links"."invoice_document_id" is null and "invoice_document_access_links"."document_identity" is null
  ));