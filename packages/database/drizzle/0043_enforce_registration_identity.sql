DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "registrations"
    WHERE "superseded_at" IS NULL AND "attendee_mobile_e164" <> ''
    GROUP BY "event_id", "attendee_mobile_e164"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'registration identity migration blocked by duplicate event/mobile registrations',
      HINT = 'Run pnpm db:repair-registration-identities, review the dry-run, then rerun with -- --apply.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "registrations"
    WHERE "superseded_at" IS NULL AND "customer_user_id" IS NOT NULL
    GROUP BY "event_id", "customer_user_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'registration identity migration blocked by duplicate event/customer registrations',
      HINT = 'Run pnpm db:repair-registration-identities, review the dry-run, then rerun with -- --apply.';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX "registrations_event_mobile_active_unique";--> statement-breakpoint
DROP INDEX "registrations_event_customer_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_event_mobile_unique" ON "registrations" USING btree ("event_id","attendee_mobile_e164") WHERE "registrations"."attendee_mobile_e164" <> '' and "registrations"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_event_customer_unique" ON "registrations" USING btree ("event_id","customer_user_id") WHERE "registrations"."customer_user_id" is not null and "registrations"."superseded_at" is null;
