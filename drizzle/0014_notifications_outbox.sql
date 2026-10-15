CREATE TYPE "kliniva"."appointment_approval_mode" AS ENUM('AUTO_ACCEPT', 'DOCTOR_APPROVAL');--> statement-breakpoint
CREATE TYPE "kliniva"."notification_severity" AS ENUM('INFO', 'SUCCESS', 'WARNING', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "kliniva"."notification_status" AS ENUM('UNREAD', 'READ', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "kliniva"."notification_type" AS ENUM('APPOINTMENT_CREATED', 'APPOINTMENT_RESCHEDULED', 'APPOINTMENT_CANCELLED', 'APPOINTMENT_CONFIRMED', 'PATIENT_CHECKED_IN', 'APPOINTMENT_READY_FOR_DOCTOR', 'APPOINTMENT_APPROVAL_REQUIRED', 'APPOINTMENT_APPROVED', 'APPOINTMENT_DECLINED', 'LOW_STOCK', 'OUT_OF_STOCK', 'LOT_EXPIRING_SOON', 'LOT_EXPIRED', 'LOT_RECALLED', 'DOCUMENT_INTEGRITY_FAILED', 'SYSTEM_SECURITY_ALERT');--> statement-breakpoint
CREATE TYPE "kliniva"."outbox_status" AS ENUM('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');--> statement-breakpoint
ALTER TYPE "kliniva"."appointment_event_type" ADD VALUE 'APPROVED';--> statement-breakpoint
ALTER TYPE "kliniva"."appointment_event_type" ADD VALUE 'DECLINED';--> statement-breakpoint
-- appointment_status + 'PENDING_APPROVAL' — "ALTER TYPE ... ADD VALUE" ile eklenen değer AYNI transaction'da
-- kullanılamaz; migrator bekleyen tüm dosyaları TEK transaction'da uyguladığından (çakışma constraint'ları yeni değeri
-- kullanır) tip yeniden oluşturulur: aynı transaction'da oluşturulan tipin değerleri güvenle kullanılabilir.
-- Bağımlılar: appointments.status, appointment_events.from_status/to_status, 3 exclusion constraint,
-- appointment_transition_allowed() — constraint'lar ve fonksiyon 0015'te yeni listeyle yeniden oluşturulur.
ALTER TABLE "kliniva"."appointments" DROP CONSTRAINT "appointments_doctor_no_overlap";--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" DROP CONSTRAINT "appointments_room_no_overlap";--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" DROP CONSTRAINT "appointments_patient_no_overlap";--> statement-breakpoint
DROP FUNCTION "kliniva"."appointment_transition_allowed"("kliniva"."appointment_status", "kliniva"."appointment_status");--> statement-breakpoint
CREATE TYPE "kliniva"."appointment_status_v2" AS ENUM('DRAFT', 'BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'PENDING_APPROVAL');--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ALTER COLUMN "status" TYPE "kliniva"."appointment_status_v2" USING "status"::text::"kliniva"."appointment_status_v2";--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ALTER COLUMN "status" SET DEFAULT 'BOOKED';--> statement-breakpoint
ALTER TABLE "kliniva"."appointment_events" ALTER COLUMN "from_status" TYPE "kliniva"."appointment_status_v2" USING "from_status"::text::"kliniva"."appointment_status_v2";--> statement-breakpoint
ALTER TABLE "kliniva"."appointment_events" ALTER COLUMN "to_status" TYPE "kliniva"."appointment_status_v2" USING "to_status"::text::"kliniva"."appointment_status_v2";--> statement-breakpoint
DROP TYPE "kliniva"."appointment_status";--> statement-breakpoint
ALTER TYPE "kliniva"."appointment_status_v2" RENAME TO "appointment_status";--> statement-breakpoint
CREATE TABLE "kliniva"."notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"notification_type" "kliniva"."notification_type" NOT NULL,
	"in_app_enabled" boolean DEFAULT true NOT NULL,
	"future_email_enabled" boolean DEFAULT false NOT NULL,
	"future_push_enabled" boolean DEFAULT false NOT NULL,
	"future_sms_enabled" boolean DEFAULT false NOT NULL,
	"future_whatsapp_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_uq" UNIQUE("tenant_id","user_id","notification_type")
);
--> statement-breakpoint
CREATE TABLE "kliniva"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"branch_id" uuid,
	"type" "kliniva"."notification_type" NOT NULL,
	"severity" "kliniva"."notification_severity" DEFAULT 'INFO' NOT NULL,
	"title" text NOT NULL,
	"body_safe" text,
	"entity_type" text,
	"entity_id" uuid,
	"status" "kliniva"."notification_status" DEFAULT 'UNREAD' NOT NULL,
	"deduplication_key" text,
	"metadata_safe" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "notifications_dedup_uq" UNIQUE("tenant_id","deduplication_key"),
	CONSTRAINT "notifications_title_ck" CHECK (length("kliniva"."notifications"."title") between 1 and 160),
	CONSTRAINT "notifications_body_ck" CHECK ("kliniva"."notifications"."body_safe" is null or length("kliniva"."notifications"."body_safe") <= 500),
	CONSTRAINT "notifications_entity_type_ck" CHECK ("kliniva"."notifications"."entity_type" is null or "kliniva"."notifications"."entity_type" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "notifications_dedup_ck" CHECK ("kliniva"."notifications"."deduplication_key" is null or length("kliniva"."notifications"."deduplication_key") between 1 and 200),
	CONSTRAINT "notifications_status_ck" CHECK (("kliniva"."notifications"."status" = 'UNREAD' and "kliniva"."notifications"."read_at" is null and "kliniva"."notifications"."archived_at" is null)
        or ("kliniva"."notifications"."status" = 'READ' and "kliniva"."notifications"."read_at" is not null and "kliniva"."notifications"."archived_at" is null)
        or ("kliniva"."notifications"."status" = 'ARCHIVED' and "kliniva"."notifications"."archived_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "kliniva"."outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload_safe" jsonb NOT NULL,
	"status" "kliniva"."outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error_code" text,
	"deduplication_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_dedup_uq" UNIQUE("tenant_id","deduplication_key"),
	CONSTRAINT "outbox_events_type_ck" CHECK ("kliniva"."outbox_events"."event_type" ~ '^[A-Z_]{3,60}$'),
	CONSTRAINT "outbox_events_aggregate_ck" CHECK ("kliniva"."outbox_events"."aggregate_type" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "outbox_events_attempts_ck" CHECK ("kliniva"."outbox_events"."attempt_count" between 0 and 100),
	CONSTRAINT "outbox_events_error_ck" CHECK ("kliniva"."outbox_events"."last_error_code" is null or "kliniva"."outbox_events"."last_error_code" ~ '^[A-Z0-9_]{1,60}$')
);
--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ADD COLUMN "approval_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD COLUMN "appointment_approval_mode" "kliniva"."appointment_approval_mode" DEFAULT 'AUTO_ACCEPT' NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."notification_preferences" ADD CONSTRAINT "notification_preferences_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."notifications" ADD CONSTRAINT "notifications_recipient_fk" FOREIGN KEY ("tenant_id","recipient_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."notifications" ADD CONSTRAINT "notifications_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "kliniva"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."outbox_events" ADD CONSTRAINT "outbox_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "kliniva"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "kliniva"."notifications" USING btree ("tenant_id","recipient_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "kliniva"."notifications" USING btree ("tenant_id","recipient_user_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_events_ready_idx" ON "kliniva"."outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "outbox_events_tenant_status_idx" ON "kliniva"."outbox_events" USING btree ("tenant_id","status","available_at");