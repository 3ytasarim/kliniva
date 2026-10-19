CREATE TABLE "kliniva"."clinical_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"file_name_encrypted" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" "kliniva"."finance_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"void_reason" text,
	CONSTRAINT "clinical_attachments_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "clinical_attachments_storage_key_uq" UNIQUE("storage_key"),
	CONSTRAINT "clinical_attachments_mime_ck" CHECK ("kliniva"."clinical_attachments"."mime_type" in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "clinical_attachments_size_ck" CHECK ("kliniva"."clinical_attachments"."size_bytes" between 1 and 5242880),
	CONSTRAINT "clinical_attachments_sha_ck" CHECK ("kliniva"."clinical_attachments"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "clinical_attachments_key_ck" CHECK ("kliniva"."clinical_attachments"."storage_key" ~ '^tenant/[0-9a-f-]{36}/clinical/[0-9a-f-]{36}[.]bin$'),
	CONSTRAINT "clinical_attachments_void_ck" CHECK (("kliniva"."clinical_attachments"."status" = 'ACTIVE' and "kliniva"."clinical_attachments"."voided_at" is null and "kliniva"."clinical_attachments"."voided_by_user_id" is null and "kliniva"."clinical_attachments"."void_reason" is null) or ("kliniva"."clinical_attachments"."status" = 'VOIDED' and "kliniva"."clinical_attachments"."voided_at" is not null and "kliniva"."clinical_attachments"."voided_by_user_id" is not null and length("kliniva"."clinical_attachments"."void_reason") between 3 and 300))
);
--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_attachments" ADD CONSTRAINT "clinical_attachments_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "kliniva"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_attachments" ADD CONSTRAINT "clinical_attachments_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "kliniva"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_attachments" ADD CONSTRAINT "clinical_attachments_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "kliniva"."doctor_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_attachments" ADD CONSTRAINT "clinical_attachments_author_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_attachments" ADD CONSTRAINT "clinical_attachments_voider_fk" FOREIGN KEY ("tenant_id","voided_by_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinical_attachments_appointment_idx" ON "kliniva"."clinical_attachments" USING btree ("tenant_id","appointment_id");--> statement-breakpoint
CREATE INDEX "clinical_attachments_patient_idx" ON "kliniva"."clinical_attachments" USING btree ("tenant_id","patient_id","created_at");