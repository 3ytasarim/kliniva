CREATE TYPE "kliniva"."appointment_event_type" AS ENUM('CREATED', 'RESCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'STARTED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'NOTES_UPDATED');--> statement-breakpoint
CREATE TYPE "kliniva"."appointment_source" AS ENUM('STAFF', 'DOCTOR', 'PATIENT_PORTAL', 'AI_VOICE', 'API');--> statement-breakpoint
CREATE TYPE "kliniva"."appointment_status" AS ENUM('DRAFT', 'BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');--> statement-breakpoint
CREATE TABLE "kliniva"."appointment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"type" "kliniva"."appointment_event_type" NOT NULL,
	"from_status" "kliniva"."appointment_status",
	"to_status" "kliniva"."appointment_status",
	"actor_user_id" uuid,
	"source" "kliniva"."appointment_source" DEFAULT 'STAFF' NOT NULL,
	"metadata_safe" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kliniva"."appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"room_id" uuid,
	"service_id" uuid,
	"status" "kliniva"."appointment_status" DEFAULT 'BOOKED' NOT NULL,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"source" "kliniva"."appointment_source" DEFAULT 'STAFF' NOT NULL,
	"notes_encrypted" text,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"checked_in_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"no_show_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancellation_reason" text,
	CONSTRAINT "appointments_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointments_time_ck" CHECK ("kliniva"."appointments"."scheduled_start" < "kliniva"."appointments"."scheduled_end"),
	CONSTRAINT "appointments_duration_ck" CHECK ("kliniva"."appointments"."duration_minutes" between 5 and 480 and extract(epoch from ("kliniva"."appointments"."scheduled_end" - "kliniva"."appointments"."scheduled_start")) = "kliniva"."appointments"."duration_minutes" * 60)
);
--> statement-breakpoint
CREATE TABLE "kliniva"."clinical_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"default_duration_minutes" integer DEFAULT 30 NOT NULL,
	"requires_room" boolean DEFAULT true NOT NULL,
	"allowed_room_types" "kliniva"."room_type"[],
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_services_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "clinical_services_tenant_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "clinical_services_tenant_code_uq" UNIQUE("tenant_id","code"),
	CONSTRAINT "clinical_services_duration_ck" CHECK ("kliniva"."clinical_services"."default_duration_minutes" between 5 and 480)
);
--> statement-breakpoint
CREATE TABLE "kliniva"."doctor_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"duration_minutes_override" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_services_uq" UNIQUE("tenant_id","doctor_id","service_id"),
	CONSTRAINT "doctor_services_duration_ck" CHECK ("kliniva"."doctor_services"."duration_minutes_override" is null or "kliniva"."doctor_services"."duration_minutes_override" between 5 and 480)
);
--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD COLUMN "min_booking_notice_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD COLUMN "max_booking_days_ahead" integer DEFAULT 365 NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD COLUMN "cancellation_reason_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD COLUMN "slot_interval_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."appointment_events" ADD CONSTRAINT "appointment_events_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "kliniva"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "kliniva"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "kliniva"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "kliniva"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "kliniva"."doctor_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_room_fk" FOREIGN KEY ("tenant_id","branch_id","room_id") REFERENCES "kliniva"."rooms"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "kliniva"."clinical_services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_services" ADD CONSTRAINT "clinical_services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "kliniva"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_services" ADD CONSTRAINT "doctor_services_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "kliniva"."doctor_profiles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_services" ADD CONSTRAINT "doctor_services_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "kliniva"."clinical_services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_events_appointment_idx" ON "kliniva"."appointment_events" USING btree ("tenant_id","appointment_id","created_at");--> statement-breakpoint
CREATE INDEX "appointments_branch_start_idx" ON "kliniva"."appointments" USING btree ("tenant_id","branch_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "appointments_doctor_start_idx" ON "kliniva"."appointments" USING btree ("tenant_id","doctor_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "appointments_patient_start_idx" ON "kliniva"."appointments" USING btree ("tenant_id","patient_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "appointments_room_start_idx" ON "kliniva"."appointments" USING btree ("tenant_id","room_id","scheduled_start");--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD CONSTRAINT "clinic_profiles_notice_ck" CHECK ("kliniva"."clinic_profiles"."min_booking_notice_minutes" between 0 and 10080);--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD CONSTRAINT "clinic_profiles_horizon_ck" CHECK ("kliniva"."clinic_profiles"."max_booking_days_ahead" between 1 and 730);--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD CONSTRAINT "clinic_profiles_slot_ck" CHECK ("kliniva"."clinic_profiles"."slot_interval_minutes" in (5, 10, 15, 20, 30, 60));