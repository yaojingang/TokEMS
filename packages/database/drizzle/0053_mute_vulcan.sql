CREATE TABLE "speaker_public_routes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "speaker_public_routes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"speaker_id" uuid NOT NULL,
	"public_code" varchar(4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "speaker_public_routes_code_format" CHECK ("speaker_public_routes"."public_code" ~ '^[a-z]{4}$')
);
--> statement-breakpoint
ALTER TABLE "speaker_public_routes" ADD CONSTRAINT "speaker_public_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speaker_public_routes" ADD CONSTRAINT "speaker_public_routes_event_scope_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "speaker_public_routes_speaker_unique" ON "speaker_public_routes" USING btree ("organization_id","event_id","speaker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "speaker_public_routes_code_unique" ON "speaker_public_routes" USING btree ("organization_id","public_code");--> statement-breakpoint
CREATE INDEX "speaker_public_routes_event_idx" ON "speaker_public_routes" USING btree ("organization_id","event_id");--> statement-breakpoint
WITH "historical_speakers" AS (
	SELECT DISTINCT
		"events"."organization_id",
		"event_releases"."event_id",
		("speaker"."value" ->> 'id')::uuid AS "speaker_id"
	FROM "event_releases"
	INNER JOIN "events" ON "events"."id" = "event_releases"."event_id"
	CROSS JOIN LATERAL jsonb_array_elements(
		COALESCE("event_releases"."snapshot" -> 'speakers', '[]'::jsonb)
	) AS "speaker"("value")
	WHERE "speaker"."value" ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
),
"route_candidates" AS (
	SELECT "organization_id", "event_id", "id" AS "speaker_id"
	FROM "speakers"
	UNION
	SELECT "organization_id", "event_id", "speaker_id"
	FROM "historical_speakers"
),
"ranked_routes" AS (
	SELECT
		"organization_id",
		"event_id",
		"speaker_id",
		row_number() OVER (
			PARTITION BY "organization_id"
			ORDER BY "event_id", "speaker_id"
		) - 1 AS "route_ordinal"
	FROM "route_candidates"
),
"coded_routes" AS (
	SELECT
		"organization_id",
		"event_id",
		"speaker_id",
		(("route_ordinal" * 104729 + 350819) % 456976)::integer AS "scrambled"
	FROM "ranked_routes"
	WHERE "route_ordinal" < 456976
)
INSERT INTO "speaker_public_routes" (
	"organization_id",
	"event_id",
	"speaker_id",
	"public_code"
)
SELECT
	"organization_id",
	"event_id",
	"speaker_id",
	chr(97 + (("scrambled" / 17576) % 26)) ||
	chr(97 + (("scrambled" / 676) % 26)) ||
	chr(97 + (("scrambled" / 26) % 26)) ||
	chr(97 + ("scrambled" % 26))
FROM "coded_routes"
ON CONFLICT ("organization_id", "event_id", "speaker_id") DO NOTHING;
