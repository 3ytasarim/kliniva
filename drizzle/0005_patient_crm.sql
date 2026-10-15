CREATE TYPE "kliniva"."signer_type" AS ENUM('PATIENT', 'PARENT', 'LEGAL_GUARDIAN');--> statement-breakpoint
ALTER TYPE "kliniva"."document_type" ADD VALUE 'COMMERCIAL_COMMUNICATION_CONSENT';--> statement-breakpoint
CREATE TABLE "kliniva"."consent_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"consent_choice_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by_user_id" uuid,
	"channel" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_revocations_choice_uq" UNIQUE("consent_choice_id"),
	CONSTRAINT "consent_revocations_channel_ck" CHECK ("kliniva"."consent_revocations"."channel" in ('IN_PERSON', 'PHONE', 'EMAIL', 'WRITTEN', 'PORTAL', 'OTHER'))
);
--> statement-breakpoint
CREATE TABLE "kliniva"."patient_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_branches_uq" UNIQUE("tenant_id","patient_id","branch_id")
);
--> statement-breakpoint
-- GENERATED → DRAFT: enum değeri yerinde yeniden adlandırılır (tip silinmez, mevcut satırlar kayıpsız korunur).
ALTER TYPE "kliniva"."patient_document_status" RENAME VALUE 'GENERATED' TO 'DRAFT';--> statement-breakpoint
ALTER TABLE "kliniva"."patient_documents" ALTER COLUMN "status" SET DEFAULT 'DRAFT';--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD COLUMN "patient_number_prefix" text DEFAULT 'KLI' NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_documents" ADD COLUMN "signer_type" "kliniva"."signer_type";--> statement-breakpoint
ALTER TABLE "kliniva"."patient_documents" ADD COLUMN "guardian_relationship" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_documents" ADD COLUMN "content_snapshot_encrypted" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_documents" ADD COLUMN "content_sha256" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_documents" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_documents" ADD COLUMN "voided_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_documents" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "phone_normalized" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "secondary_phone" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "email_normalized" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "nationality" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "preferred_language" text DEFAULT 'TR' NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "district" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "emergency_contact_name" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "emergency_contact_phone" text;--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ADD COLUMN "national_id_encrypted" text;--> statement-breakpoint
ALTER TABLE "kliniva"."consent_choices" ADD CONSTRAINT "consent_choices_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "kliniva"."consent_revocations" ADD CONSTRAINT "consent_revocations_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "kliniva"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."consent_revocations" ADD CONSTRAINT "consent_revocations_choice_fk" FOREIGN KEY ("tenant_id","consent_choice_id") REFERENCES "kliniva"."consent_choices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_branches" ADD CONSTRAINT "patient_branches_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "kliniva"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_branches" ADD CONSTRAINT "patient_branches_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "kliniva"."branches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_revocations_patient_idx" ON "kliniva"."consent_revocations" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_branches_branch_idx" ON "kliniva"."patient_branches" USING btree ("tenant_id","branch_id");--> statement-breakpoint
CREATE INDEX "patients_tenant_phone_idx" ON "kliniva"."patients" USING btree ("tenant_id","phone_normalized");--> statement-breakpoint
CREATE INDEX "patients_tenant_email_idx" ON "kliniva"."patients" USING btree ("tenant_id","email_normalized");--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD CONSTRAINT "clinic_profiles_prefix_ck" CHECK ("kliniva"."clinic_profiles"."patient_number_prefix" ~ '^[A-Z0-9]{2,8}$');