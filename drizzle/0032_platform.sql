CREATE TYPE "kliniva"."platform_session_state" AS ENUM('MFA_SETUP', 'MFA_PENDING', 'ACTIVE');--> statement-breakpoint
CREATE TABLE "kliniva"."platform_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"two_factor_secret_encrypted" text,
	"two_factor_last_used_step" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_admins_email_normalized_unique" UNIQUE("email_normalized")
);
--> statement-breakpoint
CREATE TABLE "kliniva"."platform_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid,
	"action" text NOT NULL,
	"target_tenant_id" uuid,
	"metadata_safe" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_audit_action_ck" CHECK ("kliniva"."platform_audit_logs"."action" ~ '^[A-Z_]{3,60}$')
);
--> statement-breakpoint
CREATE TABLE "kliniva"."platform_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"admin_id" uuid NOT NULL,
	"state" "kliniva"."platform_session_state" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_hash" text,
	"user_agent_summary" text,
	CONSTRAINT "platform_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "kliniva"."users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."users" ALTER COLUMN "email_normalized" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."users" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "kliniva"."users" ADD COLUMN "username_normalized" text;--> statement-breakpoint
ALTER TABLE "kliniva"."users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_admin_id_platform_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "kliniva"."platform_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."platform_sessions" ADD CONSTRAINT "platform_sessions_admin_id_platform_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "kliniva"."platform_admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_audit_created_idx" ON "kliniva"."platform_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "platform_sessions_admin_idx" ON "kliniva"."platform_sessions" USING btree ("admin_id");--> statement-breakpoint
ALTER TABLE "kliniva"."users" ADD CONSTRAINT "users_tenant_username_uq" UNIQUE("tenant_id","username_normalized");--> statement-breakpoint
ALTER TABLE "kliniva"."users" ADD CONSTRAINT "users_login_id_ck" CHECK ("kliniva"."users"."email_normalized" is not null or "kliniva"."users"."username_normalized" is not null);--> statement-breakpoint
ALTER TABLE "kliniva"."users" ADD CONSTRAINT "users_username_ck" CHECK ("kliniva"."users"."username_normalized" is null or "kliniva"."users"."username_normalized" ~ '^[a-z0-9][a-z0-9._-]{2,39}$');