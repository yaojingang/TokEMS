CREATE TABLE "attendee_need_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"content" varchar(200) NOT NULL,
	"tag_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_published_at" timestamp with time zone,
	"admin_edited_at" timestamp with time zone,
	"admin_edit_reason" varchar(500),
	"admin_hidden_at" timestamp with time zone,
	"admin_hidden_reason" varchar(500),
	"deleted_at" timestamp with time zone,
	"deleted_by_type" varchar(20),
	"deleted_reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendee_need_questions_position_range" CHECK ("attendee_need_questions"."position" between 1 and 3),
	CONSTRAINT "attendee_need_questions_content_length" CHECK (char_length(trim("attendee_need_questions"."content")) between 5 and 200),
	CONSTRAINT "attendee_need_questions_tag_count" CHECK (jsonb_typeof("attendee_need_questions"."tag_codes") = 'array' and jsonb_array_length("attendee_need_questions"."tag_codes") between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "attendee_need_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"registration_id" uuid NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"is_anonymous" boolean DEFAULT true NOT NULL,
	"attribution_name" varchar(120),
	"consent_version" varchar(40),
	"consent_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendee_need_submissions_version_positive" CHECK ("attendee_need_submissions"."version" > 0),
	CONSTRAINT "attendee_need_submissions_named_public_attribution" CHECK ("attendee_need_submissions"."is_public" = false or "attendee_need_submissions"."is_anonymous" = true or coalesce(length(trim("attendee_need_submissions"."attribution_name")), 0) > 0),
	CONSTRAINT "attendee_need_submissions_public_consent" CHECK ("attendee_need_submissions"."is_public" = false or ("attendee_need_submissions"."consent_version" is not null and "attendee_need_submissions"."consent_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "attendee_need_questions" ADD CONSTRAINT "attendee_need_questions_submission_id_attendee_need_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."attendee_need_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_need_submissions" ADD CONSTRAINT "attendee_need_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_need_submissions" ADD CONSTRAINT "attendee_need_submissions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_need_submissions" ADD CONSTRAINT "attendee_need_submissions_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_need_submissions" ADD CONSTRAINT "attendee_need_submissions_customer_user_id_customer_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."customer_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_need_submissions" ADD CONSTRAINT "attendee_need_submissions_registration_scope_fk" FOREIGN KEY ("registration_id","organization_id","event_id") REFERENCES "public"."registrations"("id","organization_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee_need_submissions" ADD CONSTRAINT "attendee_need_submissions_customer_org_fk" FOREIGN KEY ("customer_user_id","organization_id") REFERENCES "public"."customer_users"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendee_need_questions_active_position_unique" ON "attendee_need_questions" USING btree ("submission_id","position") WHERE "attendee_need_questions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "attendee_need_questions_public_idx" ON "attendee_need_questions" USING btree ("first_published_at","id","admin_hidden_at","deleted_at");--> statement-breakpoint
CREATE INDEX "attendee_need_questions_tags_idx" ON "attendee_need_questions" USING gin ("tag_codes");--> statement-breakpoint
CREATE INDEX "attendee_need_questions_submission_idx" ON "attendee_need_questions" USING btree ("submission_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "attendee_need_submissions_registration_unique" ON "attendee_need_submissions" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "attendee_need_submissions_event_public_idx" ON "attendee_need_submissions" USING btree ("event_id","is_public","updated_at");--> statement-breakpoint
CREATE INDEX "attendee_need_submissions_customer_idx" ON "attendee_need_submissions" USING btree ("customer_user_id","updated_at");
