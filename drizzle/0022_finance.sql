CREATE TYPE "kliniva"."cash_kind" AS ENUM('INCOME', 'EXPENSE');--> statement-breakpoint
CREATE TYPE "kliniva"."charge_source" AS ENUM('APPOINTMENT', 'MANUAL');--> statement-breakpoint
CREATE TYPE "kliniva"."finance_status" AS ENUM('ACTIVE', 'VOIDED');--> statement-breakpoint
CREATE TYPE "kliniva"."payment_method" AS ENUM('CASH', 'CARD', 'TRANSFER', 'OTHER');--> statement-breakpoint
CREATE TABLE "kliniva"."cash_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "kliniva"."cash_kind" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_categories_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "cash_categories_name_uq" UNIQUE("tenant_id","kind","name"),
	CONSTRAINT "cash_categories_name_ck" CHECK (length("kliniva"."cash_categories"."name") between 2 and 60)
);
--> statement-breakpoint
CREATE TABLE "kliniva"."cash_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" "kliniva"."cash_kind" NOT NULL,
	"category_id" uuid,
	"method" "kliniva"."payment_method" NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'TRY' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"patient_id" uuid,
	"appointment_id" uuid,
	"description" text,
	"status" "kliniva"."finance_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"void_reason" text,
	CONSTRAINT "cash_transactions_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "cash_transactions_amount_ck" CHECK ("kliniva"."cash_transactions"."amount_minor" between 1 and 1000000000),
	CONSTRAINT "cash_transactions_currency_ck" CHECK ("kliniva"."cash_transactions"."currency" in ('TRY', 'EUR', 'USD', 'GBP')),
	CONSTRAINT "cash_transactions_description_ck" CHECK ("kliniva"."cash_transactions"."description" is null or length("kliniva"."cash_transactions"."description") <= 300),
	CONSTRAINT "cash_transactions_patient_ck" CHECK (("kliniva"."cash_transactions"."kind" = 'INCOME' or "kliniva"."cash_transactions"."patient_id" is null) and ("kliniva"."cash_transactions"."appointment_id" is null or "kliniva"."cash_transactions"."patient_id" is not null)),
	CONSTRAINT "cash_transactions_void_ck" CHECK (("kliniva"."cash_transactions"."status" = 'ACTIVE' and "kliniva"."cash_transactions"."voided_at" is null and "kliniva"."cash_transactions"."voided_by_user_id" is null and "kliniva"."cash_transactions"."void_reason" is null) or ("kliniva"."cash_transactions"."status" = 'VOIDED' and "kliniva"."cash_transactions"."voided_at" is not null and "kliniva"."cash_transactions"."voided_by_user_id" is not null and length("kliniva"."cash_transactions"."void_reason") between 3 and 300))
);
--> statement-breakpoint
CREATE TABLE "kliniva"."patient_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"service_id" uuid,
	"source" "kliniva"."charge_source" DEFAULT 'MANUAL' NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"discount_minor" integer DEFAULT 0 NOT NULL,
	"total_minor" integer NOT NULL,
	"currency" text DEFAULT 'TRY' NOT NULL,
	"status" "kliniva"."finance_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"void_reason" text,
	CONSTRAINT "patient_charges_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_charges_quantity_ck" CHECK ("kliniva"."patient_charges"."quantity" between 1 and 1000),
	CONSTRAINT "patient_charges_price_ck" CHECK ("kliniva"."patient_charges"."unit_price_minor" between 0 and 1000000000),
	CONSTRAINT "patient_charges_total_ck" CHECK ("kliniva"."patient_charges"."discount_minor" >= 0 and "kliniva"."patient_charges"."total_minor" >= 0 and "kliniva"."patient_charges"."total_minor" = "kliniva"."patient_charges"."quantity"::bigint * "kliniva"."patient_charges"."unit_price_minor" - "kliniva"."patient_charges"."discount_minor"),
	CONSTRAINT "patient_charges_currency_ck" CHECK ("kliniva"."patient_charges"."currency" in ('TRY', 'EUR', 'USD', 'GBP')),
	CONSTRAINT "patient_charges_description_ck" CHECK (length("kliniva"."patient_charges"."description") between 1 and 200),
	CONSTRAINT "patient_charges_void_ck" CHECK (("kliniva"."patient_charges"."status" = 'ACTIVE' and "kliniva"."patient_charges"."voided_at" is null and "kliniva"."patient_charges"."voided_by_user_id" is null and "kliniva"."patient_charges"."void_reason" is null) or ("kliniva"."patient_charges"."status" = 'VOIDED' and "kliniva"."patient_charges"."voided_at" is not null and "kliniva"."patient_charges"."voided_by_user_id" is not null and length("kliniva"."patient_charges"."void_reason") between 3 and 300)),
	CONSTRAINT "patient_charges_source_ck" CHECK ("kliniva"."patient_charges"."source" = 'MANUAL' or ("kliniva"."patient_charges"."appointment_id" is not null and "kliniva"."patient_charges"."service_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_services" ADD COLUMN "price_minor" integer;--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_services" ADD COLUMN "currency" text DEFAULT 'TRY' NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."cash_categories" ADD CONSTRAINT "cash_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "kliniva"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."cash_transactions" ADD CONSTRAINT "cash_transactions_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "kliniva"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."cash_transactions" ADD CONSTRAINT "cash_transactions_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "kliniva"."cash_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."cash_transactions" ADD CONSTRAINT "cash_transactions_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "kliniva"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."cash_transactions" ADD CONSTRAINT "cash_transactions_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "kliniva"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."cash_transactions" ADD CONSTRAINT "cash_transactions_creator_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."cash_transactions" ADD CONSTRAINT "cash_transactions_voider_fk" FOREIGN KEY ("tenant_id","voided_by_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_charges" ADD CONSTRAINT "patient_charges_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "kliniva"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_charges" ADD CONSTRAINT "patient_charges_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "kliniva"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_charges" ADD CONSTRAINT "patient_charges_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "kliniva"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_charges" ADD CONSTRAINT "patient_charges_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "kliniva"."clinical_services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_charges" ADD CONSTRAINT "patient_charges_creator_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_charges" ADD CONSTRAINT "patient_charges_voider_fk" FOREIGN KEY ("tenant_id","voided_by_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_transactions_occurred_idx" ON "kliniva"."cash_transactions" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cash_transactions_patient_idx" ON "kliniva"."cash_transactions" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE INDEX "cash_transactions_branch_idx" ON "kliniva"."cash_transactions" USING btree ("tenant_id","branch_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_charges_auto_uq" ON "kliniva"."patient_charges" USING btree ("tenant_id","appointment_id") WHERE source = 'APPOINTMENT' and status = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "patient_charges_patient_idx" ON "kliniva"."patient_charges" USING btree ("tenant_id","patient_id","created_at");--> statement-breakpoint
CREATE INDEX "patient_charges_appointment_idx" ON "kliniva"."patient_charges" USING btree ("tenant_id","appointment_id");--> statement-breakpoint
CREATE INDEX "patient_charges_branch_idx" ON "kliniva"."patient_charges" USING btree ("tenant_id","branch_id","created_at");--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_services" ADD CONSTRAINT "clinical_services_price_ck" CHECK ("kliniva"."clinical_services"."price_minor" is null or "kliniva"."clinical_services"."price_minor" between 0 and 1000000000);--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_services" ADD CONSTRAINT "clinical_services_currency_ck" CHECK ("kliniva"."clinical_services"."currency" in ('TRY', 'EUR', 'USD', 'GBP'));