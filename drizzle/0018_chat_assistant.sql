ALTER TYPE "kliniva"."appointment_source" ADD VALUE 'AI_CHAT';--> statement-breakpoint
ALTER TYPE "kliniva"."audit_source" ADD VALUE 'AI_CHAT';--> statement-breakpoint
ALTER TABLE "kliniva"."voice_sessions" ADD COLUMN "channel" text DEFAULT 'VOICE' NOT NULL;--> statement-breakpoint
CREATE INDEX "voice_sessions_user_channel_idx" ON "kliniva"."voice_sessions" USING btree ("tenant_id","user_id","channel","status");--> statement-breakpoint
ALTER TABLE "kliniva"."voice_sessions" ADD CONSTRAINT "voice_sessions_channel_ck" CHECK ("kliniva"."voice_sessions"."channel" in ('VOICE', 'CHAT'));