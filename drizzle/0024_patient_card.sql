CREATE TYPE "kliniva"."patient_lookup_kind" AS ENUM('SOURCE', 'INSURER');--> statement-breakpoint
CREATE TABLE "kliniva"."patient_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "kliniva"."patient_lookup_kind" NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_lookups_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_lookups_name_uq" UNIQUE("tenant_id","kind","name"),
	CONSTRAINT "patient_lookups_name_ck" CHECK (length("kliniva"."patient_lookups"."name") between 2 and 60)
);
--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "insurer_id" uuid;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "social_security" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "referral" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "sms_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "health_profile_encrypted" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_lookups" ADD CONSTRAINT "patient_lookups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "kliniva"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD CONSTRAINT "patients_source_fk" FOREIGN KEY ("tenant_id","source_id") REFERENCES "kliniva"."patient_lookups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD CONSTRAINT "patients_insurer_fk" FOREIGN KEY ("tenant_id","insurer_id") REFERENCES "kliniva"."patient_lookups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patients_source_idx" ON "kliniva"."patients" USING btree ("tenant_id","source_id");--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD CONSTRAINT "patients_social_security_ck" CHECK ("kliniva"."patients"."social_security" is null or "kliniva"."patients"."social_security" in ('NONE', 'SGK', 'BAG_KUR', 'EMEKLI_SANDIGI', 'GSS', 'OTHER'));--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD CONSTRAINT "patients_referral_ck" CHECK ("kliniva"."patients"."referral" is null or length("kliniva"."patients"."referral") <= 120);