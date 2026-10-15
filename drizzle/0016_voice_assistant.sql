CREATE TYPE "kliniva"."ai_action_status" AS ENUM('REQUESTED', 'CONFIRMED', 'SUCCEEDED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "kliniva"."pending_ai_action_status" AS ENUM('PENDING', 'CONFIRMED', 'EXECUTED', 'FAILED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "kliniva"."voice_privacy_mode" AS ENUM('STANDARD', 'DISCREET');--> statement-breakpoint
CREATE TYPE "kliniva"."voice_session_status" AS ENUM('ACTIVE', 'ENDED', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TABLE "kliniva"."ai_action_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"voice_session_id" uuid,
	"tool_name" text NOT NULL,
	"action_type" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"status" "kliniva"."ai_action_status" DEFAULT 'REQUESTED' NOT NULL,
	"confirmation_required" boolean DEFAULT true NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"safe_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_action_logs_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "ai_action_logs_tool_ck" CHECK ("kliniva"."ai_action_logs"."tool_name" ~ '^voice_[a-z_]{2,60}$'),
	CONSTRAINT "ai_action_logs_action_type_ck" CHECK ("kliniva"."ai_action_logs"."action_type" in ('READ', 'WRITE')),
	CONSTRAINT "ai_action_logs_entity_type_ck" CHECK ("kliniva"."ai_action_logs"."entity_type" is null or "kliniva"."ai_action_logs"."entity_type" ~ '^[a-z_]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "kliniva"."pending_ai_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"voice_session_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"safe_input_hash" text NOT NULL,
	"input_encrypted" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"ai_action_log_id" uuid,
	"status" "kliniva"."pending_ai_action_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"result_entity_id" uuid,
	"result_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_ai_actions_tool_ck" CHECK ("kliniva"."pending_ai_actions"."tool_name" ~ '^voice_[a-z_]{2,60}$'),
	CONSTRAINT "pending_ai_actions_hash_ck" CHECK ("kliniva"."pending_ai_actions"."safe_input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pending_ai_actions_key_ck" CHECK ("kliniva"."pending_ai_actions"."idempotency_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pending_ai_actions_result_ck" CHECK ("kliniva"."pending_ai_actions"."result_code" is null or "kliniva"."pending_ai_actions"."result_code" ~ '^[A-Z0-9_]{1,60}$')
);
--> statement-breakpoint
CREATE TABLE "kliniva"."voice_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "kliniva"."voice_session_status" DEFAULT 'ACTIVE' NOT NULL,
	"language" text DEFAULT 'tr' NOT NULL,
	"transport" text DEFAULT 'openai' NOT NULL,
	"client_session_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_sessions_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "voice_sessions_tenant_id_user_uq" UNIQUE("tenant_id","id","user_id"),
	CONSTRAINT "voice_sessions_language_ck" CHECK ("kliniva"."voice_sessions"."language" in ('tr', 'en')),
	CONSTRAINT "voice_sessions_transport_ck" CHECK ("kliniva"."voice_sessions"."transport" in ('openai', 'mock')),
	CONSTRAINT "voice_sessions_client_id_ck" CHECK ("kliniva"."voice_sessions"."client_session_id" is null or length("kliniva"."voice_sessions"."client_session_id") <= 120)
);
--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD COLUMN "voice_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD COLUMN "voice_privacy_mode" "kliniva"."voice_privacy_mode" DEFAULT 'DISCREET' NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD COLUMN "preferred_voice_language" text DEFAULT 'tr' NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."ai_action_logs" ADD CONSTRAINT "ai_action_logs_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."ai_action_logs" ADD CONSTRAINT "ai_action_logs_session_fk" FOREIGN KEY ("tenant_id","voice_session_id","user_id") REFERENCES "kliniva"."voice_sessions"("tenant_id","id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."pending_ai_actions" ADD CONSTRAINT "pending_ai_actions_session_fk" FOREIGN KEY ("tenant_id","voice_session_id","user_id") REFERENCES "kliniva"."voice_sessions"("tenant_id","id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."pending_ai_actions" ADD CONSTRAINT "pending_ai_actions_log_fk" FOREIGN KEY ("tenant_id","ai_action_log_id") REFERENCES "kliniva"."ai_action_logs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."voice_sessions" ADD CONSTRAINT "voice_sessions_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_action_logs_tenant_created_idx" ON "kliniva"."ai_action_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_action_logs_session_idx" ON "kliniva"."ai_action_logs" USING btree ("tenant_id","voice_session_id");--> statement-breakpoint
CREATE INDEX "pending_ai_actions_session_idx" ON "kliniva"."pending_ai_actions" USING btree ("tenant_id","voice_session_id","status");--> statement-breakpoint
CREATE INDEX "voice_sessions_user_active_idx" ON "kliniva"."voice_sessions" USING btree ("tenant_id","user_id","status");--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD CONSTRAINT "clinic_profiles_voice_language_ck" CHECK ("kliniva"."clinic_profiles"."preferred_voice_language" in ('tr', 'en'));