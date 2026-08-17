CREATE TABLE "agent_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"delegated_user_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"authorized_by" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"client_id" varchar(120) NOT NULL,
	"dpop_thumbprint" varchar(160) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_policy" varchar(40) DEFAULT 'controlled-and-critical' NOT NULL,
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"delegated_credential_version" varchar(160) NOT NULL,
	"delegated_membership_version" varchar(80) NOT NULL,
	"catalog_version" varchar(32) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_connections_approval_policy_check" CHECK ("agent_connections"."approval_policy" in ('controlled-and-critical', 'critical-only')),
	CONSTRAINT "agent_connections_status_check" CHECK ("agent_connections"."status" in ('active', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "agent_device_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" varchar(64) NOT NULL,
	"user_code_hmac" varchar(64) NOT NULL,
	"client_id" varchar(120) NOT NULL,
	"client_name" varchar(120) NOT NULL,
	"skill_version" varchar(40) NOT NULL,
	"resource" varchar(500) NOT NULL,
	"requested_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_scopes" jsonb,
	"approval_policy" varchar(40),
	"dpop_thumbprint" varchar(160) NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"polling_interval_seconds" integer DEFAULT 5 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"organization_id" uuid,
	"approved_by" uuid,
	"membership_id" uuid,
	"step_up_jti" varchar(160),
	"approved_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_device_authorizations_status_check" CHECK ("agent_device_authorizations"."status" in ('pending', 'approved', 'denied', 'consumed', 'expired')),
	CONSTRAINT "agent_device_authorizations_interval_check" CHECK ("agent_device_authorizations"."polling_interval_seconds" between 5 and 60)
);
--> statement-breakpoint
CREATE TABLE "agent_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"delegated_user_id" uuid NOT NULL,
	"action_id" varchar(160) NOT NULL,
	"route_name" varchar(120) NOT NULL,
	"target_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data_class" varchar(24) NOT NULL,
	"risk" varchar(24) NOT NULL,
	"reason" text NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"before_fingerprint" varchar(64) NOT NULL,
	"redacted_diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"impact_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" varchar(160),
	"execution_strategy" varchar(40),
	"status" varchar(32) DEFAULT 'prepared' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_expires_at" timestamp with time zone,
	"execution_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"response_status" integer,
	"redacted_result" jsonb,
	"one_time_secret_ciphertext" text,
	"one_time_secret_expires_at" timestamp with time zone,
	"one_time_secret_claimed_at" timestamp with time zone,
	"verification_status" varchar(24) DEFAULT 'pending' NOT NULL,
	"domain_audit_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trace_id" varchar(120) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_operations_data_class_check" CHECK ("agent_operations"."data_class" in ('public', 'internal', 'pii', 'secret')),
	CONSTRAINT "agent_operations_risk_check" CHECK ("agent_operations"."risk" in ('read', 'sensitive-read', 'routine-write', 'controlled', 'critical')),
	CONSTRAINT "agent_operations_status_check" CHECK ("agent_operations"."status" in ('prepared', 'approval_required', 'approved', 'executing', 'queued', 'succeeded', 'failed', 'unknown', 'denied', 'cancelled', 'expired')),
	CONSTRAINT "agent_operations_verification_status_check" CHECK ("agent_operations"."verification_status" in ('pending', 'verified', 'unverified', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "agent_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"family_id" uuid NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"replacement_token_ciphertext" text,
	"replay_expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cooperation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"request_no" varchar(32) NOT NULL,
	"cooperation_types" jsonb NOT NULL,
	"company_name" varchar(160) NOT NULL,
	"contact_name" varchar(80) NOT NULL,
	"contact_title" varchar(80) DEFAULT '' NOT NULL,
	"mobile_e164" varchar(24) DEFAULT '' NOT NULL,
	"email_normalized" varchar(255) DEFAULT '' NOT NULL,
	"wechat_id" varchar(80) DEFAULT '' NOT NULL,
	"message" text NOT NULL,
	"status" varchar(24) DEFAULT 'new' NOT NULL,
	"internal_note" text DEFAULT '' NOT NULL,
	"first_contacted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cooperation_requests_status_check" CHECK ("cooperation_requests"."status" in ('new', 'contacted', 'converted', 'closed')),
	CONSTRAINT "cooperation_requests_types_count_check" CHECK (jsonb_array_length("cooperation_requests"."cooperation_types") between 1 and 3),
	CONSTRAINT "cooperation_requests_contact_check" CHECK ("cooperation_requests"."mobile_e164" <> '' or "cooperation_requests"."email_normalized" <> '' or "cooperation_requests"."wechat_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "settings" SET DEFAULT '{"brandName":"大会管理中心","defaultTimezone":"Asia/Shanghai","defaultCurrency":"CNY","defaultBlueprintId":null,"defaultTemplateId":null,"customerAccounts":{"defaultAccountMode":"mobile_otp_required","termsUrl":"","termsVersion":"","privacyUrl":"","privacyVersion":""},"website":{"siteName":"大会报名中心","seoTitle":"大会报名中心","seoDescription":"","faviconUrl":"","footerText":"","icpNumber":"","supportEmail":""},"analytics":{"enabled":false,"activationVersion":null,"provider":"baidu","trackingId":"","scriptUrl":"","siteId":""}}'::jsonb;--> statement-breakpoint
ALTER TABLE "speakers" ADD COLUMN "avatar_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "speakers" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "speakers" ADD COLUMN "topic_abstract" text;--> statement-breakpoint
ALTER TABLE "speakers" ADD COLUMN "website_url" varchar(500);--> statement-breakpoint
ALTER TABLE "speakers" ADD COLUMN "social_links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_delegated_user_id_users_id_fk" FOREIGN KEY ("delegated_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_membership_scope_fk" FOREIGN KEY ("membership_id","organization_id","delegated_user_id") REFERENCES "public"."memberships"("id","organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_device_authorizations" ADD CONSTRAINT "agent_device_authorizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_device_authorizations" ADD CONSTRAINT "agent_device_authorizations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_device_authorizations" ADD CONSTRAINT "agent_device_authorizations_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_device_authorizations" ADD CONSTRAINT "agent_device_authorizations_membership_scope_fk" FOREIGN KEY ("membership_id","organization_id","approved_by") REFERENCES "public"."memberships"("id","organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_connection_id_agent_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."agent_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_delegated_user_id_users_id_fk" FOREIGN KEY ("delegated_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_connection_scope_fk" FOREIGN KEY ("connection_id","organization_id","delegated_user_id") REFERENCES "public"."agent_connections"("id","organization_id","delegated_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_refresh_tokens" ADD CONSTRAINT "agent_refresh_tokens_connection_id_agent_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."agent_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_refresh_tokens" ADD CONSTRAINT "agent_refresh_tokens_replaced_by_id_agent_refresh_tokens_id_fk" FOREIGN KEY ("replaced_by_id") REFERENCES "public"."agent_refresh_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cooperation_requests" ADD CONSTRAINT "cooperation_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cooperation_requests" ADD CONSTRAINT "cooperation_requests_event_scope_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_connections_org_status_idx" ON "agent_connections" USING btree ("organization_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "agent_connections_membership_idx" ON "agent_connections" USING btree ("membership_id","status");--> statement-breakpoint
CREATE INDEX "agent_connections_last_used_idx" ON "agent_connections" USING btree ("last_used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connections_id_org_user_unique" ON "agent_connections" USING btree ("id","organization_id","delegated_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_device_authorizations_device_code_unique" ON "agent_device_authorizations" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_device_authorizations_user_code_unique" ON "agent_device_authorizations" USING btree ("user_code_hmac");--> statement-breakpoint
CREATE INDEX "agent_device_authorizations_status_expiry_idx" ON "agent_device_authorizations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_operations_connection_idempotency_unique" ON "agent_operations" USING btree ("connection_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_operations_connection_status_idx" ON "agent_operations" USING btree ("connection_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_operations_org_action_time_idx" ON "agent_operations" USING btree ("organization_id","action_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_operations_expiry_idx" ON "agent_operations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_refresh_tokens_hash_unique" ON "agent_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_refresh_tokens_family_sequence_unique" ON "agent_refresh_tokens" USING btree ("family_id","sequence");--> statement-breakpoint
CREATE INDEX "agent_refresh_tokens_connection_idx" ON "agent_refresh_tokens" USING btree ("connection_id","expires_at");--> statement-breakpoint
CREATE INDEX "agent_refresh_tokens_family_idx" ON "agent_refresh_tokens" USING btree ("family_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cooperation_requests_request_no_unique" ON "cooperation_requests" USING btree ("request_no");--> statement-breakpoint
CREATE INDEX "cooperation_requests_event_status_time_idx" ON "cooperation_requests" USING btree ("organization_id","event_id","status","created_at");--> statement-breakpoint
CREATE INDEX "cooperation_requests_event_time_idx" ON "cooperation_requests" USING btree ("organization_id","event_id","created_at");--> statement-breakpoint
ALTER TABLE "speakers" ADD CONSTRAINT "speakers_avatar_asset_id_template_assets_id_fk" FOREIGN KEY ("avatar_asset_id") REFERENCES "public"."template_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_id_org_user_unique" ON "memberships" USING btree ("id","organization_id","user_id");