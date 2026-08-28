ALTER TABLE "attendee_need_questions" ALTER COLUMN "tag_codes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "attendee_need_questions" ADD CONSTRAINT "attendee_need_questions_tag_values" CHECK ("attendee_need_questions"."tag_codes" <@ '["geo-monetization","geo-domestic","geo-global","enterprise-adoption","geo-strategy-budget","geo-roi","ai-search-citations","model-platform-rules","geo-monitoring","content-assets","enterprise-knowledge-base","structured-data-implementation","brand-authority","ai-marketing","agent-marketing-distribution","fde","customer-acquisition-growth","service-delivery-pricing","geo-team-talent","other-geo-ai"]'::jsonb
        and (jsonb_array_length("attendee_need_questions"."tag_codes") < 2 or "attendee_need_questions"."tag_codes"->0 <> "attendee_need_questions"."tag_codes"->1)
        and (jsonb_array_length("attendee_need_questions"."tag_codes") < 3 or ("attendee_need_questions"."tag_codes"->0 <> "attendee_need_questions"."tag_codes"->2 and "attendee_need_questions"."tag_codes"->1 <> "attendee_need_questions"."tag_codes"->2)));--> statement-breakpoint
CREATE FUNCTION "anonymize_attendee_needs_on_registration_supersede"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."superseded_at" IS NULL AND NEW."superseded_at" IS NOT NULL THEN
		UPDATE "attendee_need_submissions"
		SET
			"is_public" = false,
			"is_anonymous" = true,
			"attribution_name" = NULL,
			"version" = "version" + 1,
			"updated_at" = now()
		WHERE "registration_id" = NEW."id";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "registrations_anonymize_attendee_needs_on_supersede"
AFTER UPDATE OF "superseded_at" ON "registrations"
FOR EACH ROW
EXECUTE FUNCTION "anonymize_attendee_needs_on_registration_supersede"();
