-- This migration runs inside the migrator's single transaction. Locks stabilize legacy validation.
LOCK TABLE orders, registrations, payments, refunds, refund_requests, inventory_reservations, invoice_requests, tickets IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE tokems_batch_legacy_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM orders) AS orders_count,
  (SELECT coalesce(sum(amount), 0) FROM orders) AS orders_amount,
  (SELECT count(*) FROM payments) AS payments_count,
  (SELECT coalesce(sum(amount), 0) FROM payments) AS payments_amount,
  (SELECT count(*) FROM refunds) AS refunds_count,
  (SELECT coalesce(sum(amount), 0) FROM refunds) AS refunds_amount,
  (SELECT count(*) FROM invoice_requests) AS invoices_count,
  (SELECT coalesce(sum(amount), 0) FROM invoice_requests) AS invoices_amount,
  (SELECT count(*) FROM tickets) AS tickets_count;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"client_id" uuid,
	"position" integer NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"unit_price" integer NOT NULL,
	"allocated_amount" integer NOT NULL,
	"pricing_snapshot" jsonb NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"cancelled_at" timestamp with time zone,
	"inventory_released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_position_check" CHECK ("order_items"."position" between 1 and 20),
	CONSTRAINT "order_items_money_check" CHECK ("order_items"."unit_price" >= 0 and "order_items"."allocated_amount" >= 0),
	CONSTRAINT "order_items_state_check" CHECK ("order_items"."state" in ('pending', 'active', 'cancelled')),
	CONSTRAINT "order_items_version_check" CHECK ("order_items"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refund_item_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"refund_request_item_id" uuid,
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"amount" integer NOT NULL,
	"basis" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_item_allocations_amount_check" CHECK ("refund_item_allocations"."amount" >= 0),
	CONSTRAINT "refund_item_allocations_basis_check" CHECK (length(trim("refund_item_allocations"."basis")) > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refund_request_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_request_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"requested_amount" integer NOT NULL,
	"approved_amount" integer,
	"rights_effect" varchar(24) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_request_items_money_check" CHECK ("refund_request_items"."requested_amount" >= 0 and ("refund_request_items"."approved_amount" is null or ("refund_request_items"."approved_amount" >= 0 and "refund_request_items"."approved_amount" <= "refund_request_items"."requested_amount"))),
	CONSTRAINT "refund_request_items_rights_check" CHECK ("refund_request_items"."rights_effect" in ('revoke', 'retain')),
	CONSTRAINT "refund_request_items_version_check" CHECK ("refund_request_items"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "invoice_requests" DROP CONSTRAINT IF EXISTS "invoice_requests_registration_id_registrations_id_fk";
--> statement-breakpoint
ALTER TABLE "invoice_requests" DROP CONSTRAINT IF EXISTS "invoice_requests_order_scope_fk";
--> statement-breakpoint
ALTER TABLE "invoice_requests" ALTER COLUMN "registration_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "registration_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD COLUMN IF NOT EXISTS "order_item_id" uuid;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "model_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "quantity" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "settled_payment_id" uuid;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "entitlements_on_hold" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "protection_scope" varchar(24) DEFAULT 'order' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_items_registration_unique" ON "order_items" USING btree ("registration_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_items_order_position_unique" ON "order_items" USING btree ("order_id","position");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_items_order_client_unique" ON "order_items" USING btree ("order_id","client_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_items_scope_unique" ON "order_items" USING btree ("id","order_id","organization_id","event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_items_registration_scope_unique" ON "order_items" USING btree ("order_id","registration_id","organization_id","event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_items_reservation_scope_unique" ON "order_items" USING btree ("id","order_id","ticket_type_id","event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_item_allocations_order_item_idx" ON "refund_item_allocations" USING btree ("order_id","order_item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refund_item_allocations_refund_item_unique" ON "refund_item_allocations" USING btree ("refund_id","order_item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refund_request_items_request_item_unique" ON "refund_request_items" USING btree ("refund_request_id","order_item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refund_request_items_allocation_scope_unique" ON "refund_request_items" USING btree ("id","payment_id","order_id","order_item_id","organization_id","event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_reservations_item_idx" ON "inventory_reservations" USING btree ("order_item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refunds_allocation_scope_unique" ON "refunds" USING btree ("id","payment_id","order_id","organization_id","event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_types_item_scope_unique" ON "ticket_types" USING btree ("id","organization_id","event_id");
--> statement-breakpoint
-- Reentrant legacy backfill. Stable IDs reuse each source row ID in the new table.
-- Current order values are retained verbatim; historical attempt prices are not reconstructed.
INSERT INTO order_items (id, order_id, registration_id, organization_id, event_id, position,
  ticket_type_id, unit_price, allocated_amount, pricing_snapshot, state, created_at, updated_at)
SELECT o.id, o.id, o.registration_id, o.organization_id, o.event_id, 1,
  r.ticket_type_id, o.amount, o.amount, o.pricing_snapshot,
  CASE WHEN r.status = 'cancelled' OR t.status = 'cancelled' THEN 'cancelled'
       WHEN r.status IN ('confirmed', 'checked_in', 'completed') OR t.status IN ('valid', 'used') THEN 'active'
       ELSE 'pending' END,
  o.created_at, o.updated_at
FROM orders o
JOIN registrations r ON r.id = o.registration_id AND r.organization_id = o.organization_id AND r.event_id = o.event_id
LEFT JOIN tickets t ON t.registration_id = r.id AND t.event_id = r.event_id AND t.ticket_type_id = r.ticket_type_id
WHERE o.model_version = 1
ORDER BY o.id
ON CONFLICT (registration_id) DO NOTHING;
--> statement-breakpoint
-- Counting all successful attempts avoids selecting an arbitrary matching payment from an ambiguous history.
WITH trusted AS (
  SELECT p.order_id, (array_agg(p.id))[1] AS payment_id
  FROM payments p JOIN orders o ON o.id = p.order_id
  WHERE o.model_version = 1 AND p.status IN ('succeeded', 'refunded')
  GROUP BY p.order_id
  HAVING count(*) = 1 AND bool_and(p.amount = o.amount AND p.currency = o.currency)
)
UPDATE orders o SET settled_payment_id = trusted.payment_id
FROM trusted WHERE o.id = trusted.order_id AND o.settled_payment_id IS NULL;
--> statement-breakpoint
-- Released reservations for an earlier ticket type retain their original identity and a null item pointer.
UPDATE inventory_reservations reservation SET order_item_id = item.id
FROM order_items item JOIN orders o ON o.id = item.order_id
WHERE o.model_version = 1 AND reservation.order_item_id IS NULL
  AND reservation.order_id = item.order_id AND reservation.event_id = item.event_id
  AND reservation.ticket_type_id = item.ticket_type_id AND reservation.quantity = 1;
--> statement-breakpoint
-- The workflow's explicit historical fullRefund flag is the only rights-effect inference used here.
-- Requests lacking this scoped snapshot remain unmapped for manual consideration.
INSERT INTO refund_request_items (id, refund_request_id, payment_id, order_id, order_item_id,
  organization_id, event_id, requested_amount, approved_amount, rights_effect, version, created_at, updated_at)
SELECT request.id, request.id, request.payment_id, request.order_id, item.id,
  request.organization_id, request.event_id, request.amount,
  CASE WHEN request.review_status = 'approved' THEN request.amount END,
  CASE WHEN request.business_snapshot->'fullRefund' = 'true'::jsonb THEN 'revoke' ELSE 'retain' END,
  request.version, request.created_at, request.updated_at
FROM refund_requests request
JOIN orders o ON o.id = request.order_id AND o.settled_payment_id = request.payment_id
JOIN order_items item ON item.order_id = o.id AND item.organization_id = request.organization_id AND item.event_id = request.event_id
WHERE o.model_version = 1 AND request.currency = o.currency AND request.amount <= item.allocated_amount
  AND request.business_snapshot->>'registrationId' = item.registration_id::text
  AND request.business_snapshot->>'ticketTypeId' = item.ticket_type_id::text
  AND request.business_snapshot->'fullRefund' IN ('true'::jsonb, 'false'::jsonb)
ORDER BY request.id
ON CONFLICT (refund_request_id, order_item_id) DO NOTHING;
--> statement-breakpoint
-- Only succeeded executions with a unique trusted original payment and conserved total are allocated.
-- Missing payments, ambiguous histories, unscoped requests and non-success executions retain their rows unchanged.
INSERT INTO refund_item_allocations (id, refund_id, payment_id, order_id, order_item_id,
  refund_request_item_id, organization_id, event_id, amount, basis, created_at, updated_at)
SELECT refund.id, refund.id, refund.payment_id, refund.order_id, item.id,
  request_item.id, refund.organization_id, refund.event_id, refund.amount,
  'legacy_single_item_verified', refund.created_at, refund.updated_at
FROM refunds refund
JOIN orders o ON o.id = refund.order_id AND o.settled_payment_id = refund.payment_id
JOIN order_items item ON item.order_id = o.id AND item.organization_id = refund.organization_id AND item.event_id = refund.event_id
LEFT JOIN refund_request_items request_item ON request_item.refund_request_id = refund.request_id
  AND request_item.order_item_id = item.id AND request_item.payment_id = refund.payment_id
WHERE o.model_version = 1 AND refund.status = 'succeeded' AND refund.amount > 0 AND refund.currency = o.currency
  AND (refund.request_id IS NULL OR request_item.id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM refunds execution
    WHERE execution.payment_id = refund.payment_id AND execution.status = 'succeeded'
      AND (execution.amount <= 0 OR execution.currency <> o.currency OR execution.order_id <> o.id
        OR execution.organization_id <> o.organization_id OR execution.event_id <> o.event_id))
  AND (SELECT sum(execution.amount) FROM refunds execution
       WHERE execution.payment_id = refund.payment_id AND execution.status = 'succeeded') <= item.allocated_amount
ORDER BY refund.id
ON CONFLICT (refund_id, order_item_id) DO NOTHING;

--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.order_items'::regclass AND conname = 'order_items_order_scope_fk') THEN
    ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_scope_fk" FOREIGN KEY ("order_id","organization_id","event_id") REFERENCES "public"."orders"("id","organization_id","event_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.order_items'::regclass AND conname = 'order_items_registration_scope_fk') THEN
    ALTER TABLE "order_items" ADD CONSTRAINT "order_items_registration_scope_fk" FOREIGN KEY ("registration_id","organization_id","event_id") REFERENCES "public"."registrations"("id","organization_id","event_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.order_items'::regclass AND conname = 'order_items_ticket_scope_fk') THEN
    ALTER TABLE "order_items" ADD CONSTRAINT "order_items_ticket_scope_fk" FOREIGN KEY ("ticket_type_id","organization_id","event_id") REFERENCES "public"."ticket_types"("id","organization_id","event_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.refund_item_allocations'::regclass AND conname = 'refund_item_allocations_refund_scope_fk') THEN
    ALTER TABLE "refund_item_allocations" ADD CONSTRAINT "refund_item_allocations_refund_scope_fk" FOREIGN KEY ("refund_id","payment_id","order_id","organization_id","event_id") REFERENCES "public"."refunds"("id","payment_id","order_id","organization_id","event_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.refund_item_allocations'::regclass AND conname = 'refund_item_allocations_payment_scope_fk') THEN
    ALTER TABLE "refund_item_allocations" ADD CONSTRAINT "refund_item_allocations_payment_scope_fk" FOREIGN KEY ("payment_id","order_id") REFERENCES "public"."payments"("id","order_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.refund_item_allocations'::regclass AND conname = 'refund_item_allocations_order_item_scope_fk') THEN
    ALTER TABLE "refund_item_allocations" ADD CONSTRAINT "refund_item_allocations_order_item_scope_fk" FOREIGN KEY ("order_item_id","order_id","organization_id","event_id") REFERENCES "public"."order_items"("id","order_id","organization_id","event_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.refund_item_allocations'::regclass AND conname = 'refund_item_allocations_request_item_scope_fk') THEN
    ALTER TABLE "refund_item_allocations" ADD CONSTRAINT "refund_item_allocations_request_item_scope_fk" FOREIGN KEY ("refund_request_item_id","payment_id","order_id","order_item_id","organization_id","event_id") REFERENCES "public"."refund_request_items"("id","payment_id","order_id","order_item_id","organization_id","event_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.refund_request_items'::regclass AND conname = 'refund_request_items_request_scope_fk') THEN
    ALTER TABLE "refund_request_items" ADD CONSTRAINT "refund_request_items_request_scope_fk" FOREIGN KEY ("refund_request_id","order_id","payment_id","organization_id","event_id") REFERENCES "public"."refund_requests"("id","order_id","payment_id","organization_id","event_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.refund_request_items'::regclass AND conname = 'refund_request_items_order_item_scope_fk') THEN
    ALTER TABLE "refund_request_items" ADD CONSTRAINT "refund_request_items_order_item_scope_fk" FOREIGN KEY ("order_item_id","order_id","organization_id","event_id") REFERENCES "public"."order_items"("id","order_id","organization_id","event_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.inventory_reservations'::regclass AND conname = 'inventory_reservations_item_scope_fk') THEN
    ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_item_scope_fk" FOREIGN KEY ("order_item_id","order_id","ticket_type_id","event_id") REFERENCES "public"."order_items"("id","order_id","ticket_type_id","event_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.invoice_requests'::regclass AND conname = 'invoice_requests_registration_item_scope_fk') THEN
    ALTER TABLE "invoice_requests" ADD CONSTRAINT "invoice_requests_registration_item_scope_fk" FOREIGN KEY ("order_id","registration_id","organization_id","event_id") REFERENCES "public"."order_items"("order_id","registration_id","organization_id","event_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.invoice_requests'::regclass AND conname = 'invoice_requests_registration_id_registrations_id_fk') THEN
    ALTER TABLE "invoice_requests" ADD CONSTRAINT "invoice_requests_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.invoice_requests'::regclass AND conname = 'invoice_requests_order_scope_fk') THEN
    ALTER TABLE "invoice_requests" ADD CONSTRAINT "invoice_requests_order_scope_fk" FOREIGN KEY ("order_id","organization_id","event_id") REFERENCES "public"."orders"("id","organization_id","event_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_settled_payment_scope_fk') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_settled_payment_scope_fk" FOREIGN KEY ("settled_payment_id","id") REFERENCES "public"."payments"("id","order_id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.inventory_reservations'::regclass AND conname = 'inventory_reservations_item_quantity_check') THEN
    ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_item_quantity_check" CHECK ("inventory_reservations"."order_item_id" is null or "inventory_reservations"."quantity" = 1);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_model_shape_check') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_model_shape_check" CHECK (("orders"."model_version" = 1 and "orders"."quantity" = 1 and "orders"."registration_id" is not null) or ("orders"."model_version" = 2 and "orders"."quantity" between 1 and 20 and "orders"."purchase_intent_id" is not null and (("orders"."quantity" = 1 and "orders"."registration_id" is not null) or ("orders"."quantity" > 1 and "orders"."registration_id" is null))));
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_version_check') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_version_check" CHECK ("orders"."version" >= 1);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.refunds'::regclass AND conname = 'refunds_protection_scope_check') THEN
    ALTER TABLE "refunds" ADD CONSTRAINT "refunds_protection_scope_check" CHECK ("refunds"."protection_scope" in ('order', 'items'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE before_row tokems_batch_legacy_before%ROWTYPE;
BEGIN
  SELECT * INTO before_row FROM tokems_batch_legacy_before;
  IF EXISTS (
    SELECT 1 FROM orders o LEFT JOIN order_items item ON item.order_id = o.id
    WHERE o.model_version = 1 GROUP BY o.id
    HAVING count(item.id) <> 1 OR min(item.registration_id::text) <> o.registration_id::text
      OR sum(item.allocated_amount) <> o.amount OR min(item.position) <> 1
  ) THEN
    RAISE EXCEPTION 'Legacy order item count, registration, position or amount validation failed';
  END IF;
  IF before_row.orders_count <> (SELECT count(*) FROM orders)
    OR before_row.orders_amount <> (SELECT coalesce(sum(amount), 0) FROM orders)
    OR before_row.payments_count <> (SELECT count(*) FROM payments)
    OR before_row.payments_amount <> (SELECT coalesce(sum(amount), 0) FROM payments)
    OR before_row.refunds_count <> (SELECT count(*) FROM refunds)
    OR before_row.refunds_amount <> (SELECT coalesce(sum(amount), 0) FROM refunds)
    OR before_row.invoices_count <> (SELECT count(*) FROM invoice_requests)
    OR before_row.invoices_amount <> (SELECT coalesce(sum(amount), 0) FROM invoice_requests)
    OR before_row.tickets_count <> (SELECT count(*) FROM tickets) THEN
    RAISE EXCEPTION 'Legacy financial history conservation validation failed';
  END IF;
END $$;

--> statement-breakpoint
-- Drizzle metadata describes static constraints; these transaction-final invariants are maintained in SQL.
CREATE OR REPLACE FUNCTION tokems_validate_order_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id uuid;
  target_ids uuid[];
  parent orders%ROWTYPE;
  item_count bigint;
  item_total bigint;
  maximum_position integer;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    target_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'DELETE' THEN
    target_ids := ARRAY[OLD.order_id];
  ELSIF TG_OP = 'INSERT' THEN
    target_ids := ARRAY[NEW.order_id];
  ELSE
    target_ids := ARRAY[OLD.order_id, NEW.order_id];
  END IF;
  FOR target_id IN SELECT DISTINCT unnest(target_ids) ORDER BY 1 LOOP
    SELECT * INTO parent FROM orders WHERE id = target_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF parent.registration_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM order_items WHERE order_id = parent.id AND registration_id <> parent.registration_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'orders_registration_item_match',
        MESSAGE = 'Single-person order registration must match its order item';
    END IF;
    IF parent.model_version = 2 THEN
      SELECT count(*), coalesce(sum(allocated_amount), 0), max(position)
        INTO item_count, item_total, maximum_position FROM order_items WHERE order_id = parent.id;
      IF item_count <> parent.quantity OR item_total <> parent.amount OR maximum_position <> parent.quantity THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'orders_items_totals_match',
          MESSAGE = 'Order item count, positions and allocated amount must match the order';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS orders_validate_items ON orders;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER orders_validate_items AFTER INSERT OR UPDATE ON orders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tokems_validate_order_items();
--> statement-breakpoint
DROP TRIGGER IF EXISTS order_items_validate_order ON order_items;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER order_items_validate_order AFTER INSERT OR UPDATE OR DELETE ON order_items
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tokems_validate_order_items();
--> statement-breakpoint
-- The optional request-item must belong to the refund execution's own request, even within one payment.
CREATE OR REPLACE FUNCTION tokems_validate_refund_allocation_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_order_id uuid;
BEGIN
  target_order_id := NEW.order_id;
  PERFORM id FROM orders WHERE id = target_order_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM refund_item_allocations allocation
    JOIN refunds refund ON refund.id = allocation.refund_id
    JOIN refund_request_items item ON item.id = allocation.refund_request_item_id
    WHERE allocation.order_id = target_order_id AND item.refund_request_id IS DISTINCT FROM refund.request_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'refund_allocations_request_match',
      MESSAGE = 'Refund allocation request item must belong to the execution request';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS refund_allocations_validate_request ON refund_item_allocations;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER refund_allocations_validate_request AFTER INSERT OR UPDATE ON refund_item_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tokems_validate_refund_allocation_request();
--> statement-breakpoint
DROP TRIGGER IF EXISTS refunds_validate_allocation_request ON refunds;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER refunds_validate_allocation_request AFTER UPDATE ON refunds
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tokems_validate_refund_allocation_request();
--> statement-breakpoint
DROP TRIGGER IF EXISTS refund_request_items_validate_allocation ON refund_request_items;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER refund_request_items_validate_allocation AFTER UPDATE ON refund_request_items
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tokems_validate_refund_allocation_request();

