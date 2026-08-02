DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "registrations"
    WHERE "attendee_mobile_e164" <> '' AND "status" <> 'cancelled'
    GROUP BY "event_id", "attendee_mobile_e164"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'registrations_event_mobile_active_unique migration blocked by duplicate active registrations',
      HINT = 'Resolve duplicate active registrations for each event_id and attendee_mobile_e164 before retrying the migration.';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "registrations_event_mobile_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_event_mobile_active_unique" ON "registrations" USING btree ("event_id","attendee_mobile_e164") WHERE "registrations"."attendee_mobile_e164" <> '' and "registrations"."status" <> 'cancelled';
