CREATE TYPE "kliniva"."room_type" AS ENUM('EXAMINATION', 'PROCEDURE', 'TREATMENT', 'LASER', 'CONSULTATION', 'SURGERY', 'OTHER');--> statement-breakpoint
CREATE TYPE "kliniva"."schedule_exception_type" AS ENUM('ALL_DAY', 'TIME_RANGE');--> statement-breakpoint
CREATE TABLE "kliniva"."branch_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"date" date NOT NULL,
	"all_day" boolean DEFAULT true NOT NULL,
	"start_time" time,
	"end_time" time,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_closures_time_ck" CHECK (("kliniva"."branch_closures"."all_day" and "kliniva"."branch_closures"."start_time" is null and "kliniva"."branch_closures"."end_time" is null) or ((not "kliniva"."branch_closures"."all_day") and "kliniva"."branch_closures"."start_time" is not null and "kliniva"."branch_closures"."end_time" is not null and "kliniva"."branch_closures"."start_time" < "kliniva"."branch_closures"."end_time"))
);
--> statement-breakpoint
CREATE TABLE "kliniva"."branch_working_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"start_time" time,
	"end_time" time,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_working_hours_day_uq" UNIQUE("branch_id","day_of_week"),
	CONSTRAINT "branch_working_hours_day_ck" CHECK ("kliniva"."branch_working_hours"."day_of_week" between 1 and 7),
	CONSTRAINT "branch_working_hours_time_ck" CHECK ((not "kliniva"."branch_working_hours"."enabled") or ("kliniva"."branch_working_hours"."start_time" is not null and "kliniva"."branch_working_hours"."end_time" is not null and "kliniva"."branch_working_hours"."start_time" < "kliniva"."branch_working_hours"."end_time"))
);
--> statement-breakpoint
CREATE TABLE "kliniva"."clinic_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"legal_name" text,
	"phone" text,
	"email" text,
	"website" text,
	"address" text,
	"city" text,
	"district" text,
	"country" text DEFAULT 'TR' NOT NULL,
	"logo_storage_key" text,
	"timezone" text DEFAULT 'Europe/Istanbul' NOT NULL,
	"default_appointment_duration_minutes" integer DEFAULT 30 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_profiles_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "clinic_profiles_duration_ck" CHECK ("kliniva"."clinic_profiles"."default_appointment_duration_minutes" between 5 and 480)
);
--> statement-breakpoint
CREATE TABLE "kliniva"."doctor_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_branches_doctor_branch_uq" UNIQUE("doctor_id","branch_id"),
	CONSTRAINT "doctor_branches_tenant_doctor_branch_uq" UNIQUE("tenant_id","doctor_id","branch_id")
);
--> statement-breakpoint
CREATE TABLE "kliniva"."doctor_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"specialty" text NOT NULL,
	"sub_specialty" text,
	"license_number" text,
	"bio" text,
	"default_appointment_duration_minutes" integer DEFAULT 30 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_profiles_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "doctor_profiles_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "doctor_profiles_duration_ck" CHECK ("kliniva"."doctor_profiles"."default_appointment_duration_minutes" between 5 and 480)
);
--> statement-breakpoint
CREATE TABLE "kliniva"."doctor_room_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"day_of_week" smallint,
	"effective_date" date,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_room_assignments_kind_ck" CHECK (("kliniva"."doctor_room_assignments"."day_of_week" is null) <> ("kliniva"."doctor_room_assignments"."effective_date" is null)),
	CONSTRAINT "doctor_room_assignments_day_ck" CHECK ("kliniva"."doctor_room_assignments"."day_of_week" is null or "kliniva"."doctor_room_assignments"."day_of_week" between 1 and 7),
	CONSTRAINT "doctor_room_assignments_time_ck" CHECK ("kliniva"."doctor_room_assignments"."start_time" < "kliniva"."doctor_room_assignments"."end_time")
);
--> statement-breakpoint
CREATE TABLE "kliniva"."doctor_schedule_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"branch_id" uuid,
	"date" date NOT NULL,
	"type" "kliniva"."schedule_exception_type" NOT NULL,
	"start_time" time,
	"end_time" time,
	"reason" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_schedule_exceptions_time_ck" CHECK (("kliniva"."doctor_schedule_exceptions"."type" = 'ALL_DAY' and "kliniva"."doctor_schedule_exceptions"."start_time" is null and "kliniva"."doctor_schedule_exceptions"."end_time" is null) or ("kliniva"."doctor_schedule_exceptions"."type" = 'TIME_RANGE' and "kliniva"."doctor_schedule_exceptions"."start_time" is not null and "kliniva"."doctor_schedule_exceptions"."end_time" is not null and "kliniva"."doctor_schedule_exceptions"."start_time" < "kliniva"."doctor_schedule_exceptions"."end_time"))
);
--> statement-breakpoint
CREATE TABLE "kliniva"."doctor_working_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_working_hours_day_ck" CHECK ("kliniva"."doctor_working_hours"."day_of_week" between 1 and 7),
	CONSTRAINT "doctor_working_hours_time_ck" CHECK ("kliniva"."doctor_working_hours"."start_time" < "kliniva"."doctor_working_hours"."end_time")
);
--> statement-breakpoint
-- rooms.type: serbest metin → enum. Mevcut değerler (TR/EN) eşlenir; bilinmeyenler OTHER olur (veri kaybı yok,
-- eski metin description boşsa oraya taşınır).
ALTER TABLE "kliniva"."rooms" ADD COLUMN "description" text;--> statement-breakpoint
UPDATE "kliniva"."rooms" SET "description" = "type" WHERE "type" IS NOT NULL AND "description" IS NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."rooms" ALTER COLUMN "type" SET DATA TYPE "kliniva"."room_type" USING (
  CASE
    WHEN "type" IS NULL THEN 'OTHER'
    WHEN upper("type") IN ('EXAMINATION','PROCEDURE','TREATMENT','LASER','CONSULTATION','SURGERY','OTHER') THEN upper("type")
    WHEN lower("type") LIKE '%muayene%' THEN 'EXAMINATION'
    WHEN lower("type") LIKE '%tedavi%' THEN 'TREATMENT'
    WHEN lower("type") LIKE '%lazer%' OR lower("type") LIKE '%laser%' THEN 'LASER'
    WHEN lower("type") LIKE '%konsült%' OR lower("type") LIKE '%görüşme%' THEN 'CONSULTATION'
    WHEN lower("type") LIKE '%ameliyat%' OR lower("type") LIKE '%cerrah%' THEN 'SURGERY'
    WHEN lower("type") LIKE '%işlem%' OR lower("type") LIKE '%prosedür%' THEN 'PROCEDURE'
    ELSE 'OTHER'
  END
)::"kliniva"."room_type";--> statement-breakpoint
ALTER TABLE "kliniva"."rooms" ALTER COLUMN "type" SET DEFAULT 'OTHER'::"kliniva"."room_type";--> statement-breakpoint
ALTER TABLE "kliniva"."rooms" ALTER COLUMN "type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."branches" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "kliniva"."branches" ADD COLUMN "district" text;--> statement-breakpoint
ALTER TABLE "kliniva"."branches" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "kliniva"."branches" ADD COLUMN "working_hours_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."rooms" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "kliniva"."rooms" ADD COLUMN "floor" text;--> statement-breakpoint
ALTER TABLE "kliniva"."branches" ADD CONSTRAINT "branches_tenant_code_uq" UNIQUE("tenant_id","code");--> statement-breakpoint
ALTER TABLE "kliniva"."rooms" ADD CONSTRAINT "rooms_tenant_branch_id_uq" UNIQUE("tenant_id","branch_id","id");--> statement-breakpoint
ALTER TABLE "kliniva"."rooms" ADD CONSTRAINT "rooms_branch_name_uq" UNIQUE("branch_id","name");--> statement-breakpoint
ALTER TABLE "kliniva"."rooms" ADD CONSTRAINT "rooms_branch_code_uq" UNIQUE("branch_id","code");--> statement-breakpoint
ALTER TABLE "kliniva"."branch_closures" ADD CONSTRAINT "branch_closures_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "kliniva"."branches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."branch_working_hours" ADD CONSTRAINT "branch_working_hours_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "kliniva"."branches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD CONSTRAINT "clinic_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "kliniva"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_branches" ADD CONSTRAINT "doctor_branches_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "kliniva"."doctor_profiles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_branches" ADD CONSTRAINT "doctor_branches_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "kliniva"."branches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_profiles" ADD CONSTRAINT "doctor_profiles_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_room_assignments" ADD CONSTRAINT "doctor_room_assignments_doctor_branch_fk" FOREIGN KEY ("tenant_id","doctor_id","branch_id") REFERENCES "kliniva"."doctor_branches"("tenant_id","doctor_id","branch_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_room_assignments" ADD CONSTRAINT "doctor_room_assignments_room_fk" FOREIGN KEY ("tenant_id","branch_id","room_id") REFERENCES "kliniva"."rooms"("tenant_id","branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_schedule_exceptions" ADD CONSTRAINT "doctor_schedule_exceptions_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "kliniva"."doctor_profiles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_schedule_exceptions" ADD CONSTRAINT "doctor_schedule_exceptions_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "kliniva"."branches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_working_hours" ADD CONSTRAINT "doctor_working_hours_doctor_branch_fk" FOREIGN KEY ("tenant_id","doctor_id","branch_id") REFERENCES "kliniva"."doctor_branches"("tenant_id","doctor_id","branch_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "branch_closures_branch_date_idx" ON "kliniva"."branch_closures" USING btree ("tenant_id","branch_id","date");--> statement-breakpoint
CREATE INDEX "doctor_room_assignments_room_idx" ON "kliniva"."doctor_room_assignments" USING btree ("tenant_id","room_id");--> statement-breakpoint
CREATE INDEX "doctor_room_assignments_doctor_idx" ON "kliniva"."doctor_room_assignments" USING btree ("tenant_id","doctor_id");--> statement-breakpoint
CREATE INDEX "doctor_schedule_exceptions_doctor_date_idx" ON "kliniva"."doctor_schedule_exceptions" USING btree ("tenant_id","doctor_id","date");--> statement-breakpoint
CREATE INDEX "doctor_working_hours_doctor_idx" ON "kliniva"."doctor_working_hours" USING btree ("tenant_id","doctor_id","day_of_week");
