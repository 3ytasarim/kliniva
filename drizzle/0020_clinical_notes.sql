CREATE TABLE "kliniva"."clinical_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_encrypted" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_notes_version_uq" UNIQUE("tenant_id","appointment_id","version"),
	CONSTRAINT "clinical_notes_version_ck" CHECK ("kliniva"."clinical_notes"."version" >= 1),
	CONSTRAINT "clinical_notes_hash_ck" CHECK ("kliniva"."clinical_notes"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_notes" ADD CONSTRAINT "clinical_notes_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "kliniva"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_notes" ADD CONSTRAINT "clinical_notes_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "kliniva"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_notes" ADD CONSTRAINT "clinical_notes_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "kliniva"."doctor_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_notes" ADD CONSTRAINT "clinical_notes_author_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinical_notes_patient_idx" ON "kliniva"."clinical_notes" USING btree ("tenant_id","patient_id","created_at");