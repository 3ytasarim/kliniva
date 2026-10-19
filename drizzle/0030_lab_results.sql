CREATE TABLE "kliniva"."lab_panels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_panels_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "lab_panels_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "lab_panels_name_ck" CHECK (length("kliniva"."lab_panels"."name") between 2 and 80),
	CONSTRAINT "lab_panels_parameters_ck" CHECK (jsonb_typeof("kliniva"."lab_panels"."parameters") = 'array')
);
--> statement-breakpoint
CREATE TABLE "kliniva"."lab_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"appointment_id" uuid,
	"sample_date" date NOT NULL,
	"values_encrypted" text NOT NULL,
	"abnormal_count" integer DEFAULT 0 NOT NULL,
	"status" "kliniva"."finance_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"void_reason" text,
	CONSTRAINT "lab_results_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "lab_results_abnormal_ck" CHECK ("kliniva"."lab_results"."abnormal_count" >= 0),
	CONSTRAINT "lab_results_void_ck" CHECK (("kliniva"."lab_results"."status" = 'ACTIVE' and "kliniva"."lab_results"."voided_at" is null and "kliniva"."lab_results"."voided_by_user_id" is null and "kliniva"."lab_results"."void_reason" is null) or ("kliniva"."lab_results"."status" = 'VOIDED' and "kliniva"."lab_results"."voided_at" is not null and "kliniva"."lab_results"."voided_by_user_id" is not null and length("kliniva"."lab_results"."void_reason") between 3 and 300))
);
--> statement-breakpoint
ALTER TABLE "kliniva"."lab_panels" ADD CONSTRAINT "lab_panels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "kliniva"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."lab_results" ADD CONSTRAINT "lab_results_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "kliniva"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."lab_results" ADD CONSTRAINT "lab_results_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "kliniva"."lab_panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."lab_results" ADD CONSTRAINT "lab_results_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "kliniva"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."lab_results" ADD CONSTRAINT "lab_results_creator_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."lab_results" ADD CONSTRAINT "lab_results_voider_fk" FOREIGN KEY ("tenant_id","voided_by_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_results_patient_idx" ON "kliniva"."lab_results" USING btree ("tenant_id","patient_id","sample_date");