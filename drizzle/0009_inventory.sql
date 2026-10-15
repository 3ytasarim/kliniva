CREATE TYPE "kliniva"."inventory_location_type" AS ENUM('BRANCH_WAREHOUSE', 'ROOM');--> statement-breakpoint
CREATE TYPE "kliniva"."inventory_unit" AS ENUM('PIECE', 'BOX', 'PACK', 'BOTTLE', 'ML', 'LITER', 'GRAM', 'KG', 'PAIR', 'SET', 'OTHER');--> statement-breakpoint
CREATE TYPE "kliniva"."material_usage_status" AS ENUM('DRAFT', 'FINALIZED', 'VOIDED');--> statement-breakpoint
CREATE TYPE "kliniva"."stock_movement_type" AS ENUM('INITIAL_STOCK', 'PURCHASE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER', 'PATIENT_USAGE', 'RETURN_FROM_PATIENT_USAGE', 'WRITE_OFF');--> statement-breakpoint
CREATE TABLE "kliniva"."inventory_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_categories_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_categories_tenant_name_uq" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "kliniva"."inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"barcode" text,
	"category_id" uuid,
	"unit" "kliniva"."inventory_unit" DEFAULT 'PIECE' NOT NULL,
	"track_inventory" boolean DEFAULT true NOT NULL,
	"track_lots" boolean DEFAULT false NOT NULL,
	"track_expiry" boolean DEFAULT false NOT NULL,
	"minimum_stock_level" numeric(14, 3),
	"active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_items_tenant_code_uq" UNIQUE("tenant_id","code"),
	CONSTRAINT "inventory_items_tenant_barcode_uq" UNIQUE("tenant_id","barcode"),
	CONSTRAINT "inventory_items_min_ck" CHECK ("kliniva"."inventory_items"."minimum_stock_level" is null or "kliniva"."inventory_items"."minimum_stock_level" >= 0)
);
--> statement-breakpoint
CREATE TABLE "kliniva"."inventory_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"type" "kliniva"."inventory_location_type" NOT NULL,
	"room_id" uuid,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_locations_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_locations_tenant_branch_id_uq" UNIQUE("tenant_id","branch_id","id"),
	CONSTRAINT "inventory_locations_branch_name_uq" UNIQUE("tenant_id","branch_id","name"),
	CONSTRAINT "inventory_locations_room_uq" UNIQUE("tenant_id","room_id"),
	CONSTRAINT "inventory_locations_room_ck" CHECK (("kliniva"."inventory_locations"."type" = 'ROOM') = ("kliniva"."inventory_locations"."room_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "kliniva"."patient_material_usage_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_usage_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"lot_id" uuid,
	"quantity" numeric(14, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pmu_items_uq" UNIQUE("tenant_id","patient_usage_id","inventory_item_id","location_id"),
	CONSTRAINT "pmu_items_quantity_ck" CHECK ("kliniva"."patient_material_usage_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "kliniva"."patient_material_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"branch_id" uuid NOT NULL,
	"room_id" uuid,
	"doctor_id" uuid,
	"status" "kliniva"."material_usage_status" DEFAULT 'DRAFT' NOT NULL,
	"notes_encrypted" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	"finalized_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"void_reason" text,
	CONSTRAINT "patient_material_usages_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "kliniva"."service_material_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clinical_service_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"default_quantity" numeric(14, 3) NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "smt_uq" UNIQUE("tenant_id","clinical_service_id","inventory_item_id"),
	CONSTRAINT "smt_quantity_ck" CHECK ("kliniva"."service_material_templates"."default_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "kliniva"."stock_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity" numeric(14, 3) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_uq" UNIQUE("tenant_id","inventory_item_id","location_id"),
	CONSTRAINT "stock_balances_non_negative_ck" CHECK ("kliniva"."stock_balances"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "kliniva"."stock_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"lot_number" text,
	"expiry_date" date,
	"quantity" numeric(14, 3) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_lots_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_lots_non_negative_ck" CHECK ("kliniva"."stock_lots"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "kliniva"."stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"movement_type" "kliniva"."stock_movement_type" NOT NULL,
	"from_location_id" uuid,
	"to_location_id" uuid,
	"quantity" numeric(14, 3) NOT NULL,
	"patient_id" uuid,
	"appointment_id" uuid,
	"patient_usage_id" uuid,
	"lot_id" uuid,
	"reference" text,
	"reason" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_quantity_ck" CHECK ("kliniva"."stock_movements"."quantity" > 0),
	CONSTRAINT "stock_movements_shape_ck" CHECK (case "kliniva"."stock_movements"."movement_type"
        when 'TRANSFER' then "kliniva"."stock_movements"."from_location_id" is not null and "kliniva"."stock_movements"."to_location_id" is not null and "kliniva"."stock_movements"."from_location_id" <> "kliniva"."stock_movements"."to_location_id"
        when 'INITIAL_STOCK' then "kliniva"."stock_movements"."from_location_id" is null and "kliniva"."stock_movements"."to_location_id" is not null
        when 'PURCHASE' then "kliniva"."stock_movements"."from_location_id" is null and "kliniva"."stock_movements"."to_location_id" is not null
        when 'ADJUSTMENT_IN' then "kliniva"."stock_movements"."from_location_id" is null and "kliniva"."stock_movements"."to_location_id" is not null
        when 'RETURN_FROM_PATIENT_USAGE' then "kliniva"."stock_movements"."from_location_id" is null and "kliniva"."stock_movements"."to_location_id" is not null and "kliniva"."stock_movements"."patient_usage_id" is not null
        when 'PATIENT_USAGE' then "kliniva"."stock_movements"."from_location_id" is not null and "kliniva"."stock_movements"."to_location_id" is null and "kliniva"."stock_movements"."patient_usage_id" is not null
        else "kliniva"."stock_movements"."from_location_id" is not null and "kliniva"."stock_movements"."to_location_id" is null end)
);
--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_tenant_id_patient_branch_uq" UNIQUE("tenant_id","id","patient_id","branch_id");--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD COLUMN "allow_negative_stock" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."inventory_categories" ADD CONSTRAINT "inventory_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "kliniva"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."inventory_items" ADD CONSTRAINT "inventory_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "kliniva"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."inventory_items" ADD CONSTRAINT "inventory_items_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "kliniva"."inventory_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."inventory_locations" ADD CONSTRAINT "inventory_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "kliniva"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."inventory_locations" ADD CONSTRAINT "inventory_locations_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "kliniva"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."inventory_locations" ADD CONSTRAINT "inventory_locations_room_fk" FOREIGN KEY ("tenant_id","branch_id","room_id") REFERENCES "kliniva"."rooms"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usage_items" ADD CONSTRAINT "pmu_items_usage_fk" FOREIGN KEY ("tenant_id","patient_usage_id") REFERENCES "kliniva"."patient_material_usages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usage_items" ADD CONSTRAINT "pmu_items_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "kliniva"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usage_items" ADD CONSTRAINT "pmu_items_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "kliniva"."inventory_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usage_items" ADD CONSTRAINT "pmu_items_lot_fk" FOREIGN KEY ("tenant_id","lot_id") REFERENCES "kliniva"."stock_lots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usages" ADD CONSTRAINT "patient_material_usages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "kliniva"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usages" ADD CONSTRAINT "patient_material_usages_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "kliniva"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usages" ADD CONSTRAINT "patient_material_usages_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "kliniva"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usages" ADD CONSTRAINT "patient_material_usages_room_fk" FOREIGN KEY ("tenant_id","branch_id","room_id") REFERENCES "kliniva"."rooms"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usages" ADD CONSTRAINT "patient_material_usages_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "kliniva"."doctor_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usages" ADD CONSTRAINT "patient_material_usages_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id","patient_id","branch_id") REFERENCES "kliniva"."appointments"("tenant_id","id","patient_id","branch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."service_material_templates" ADD CONSTRAINT "smt_service_fk" FOREIGN KEY ("tenant_id","clinical_service_id") REFERENCES "kliniva"."clinical_services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."service_material_templates" ADD CONSTRAINT "smt_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "kliniva"."inventory_items"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_balances" ADD CONSTRAINT "stock_balances_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "kliniva"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_balances" ADD CONSTRAINT "stock_balances_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "kliniva"."inventory_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ADD CONSTRAINT "stock_lots_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "kliniva"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ADD CONSTRAINT "stock_lots_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "kliniva"."inventory_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_movements" ADD CONSTRAINT "stock_movements_item_fk" FOREIGN KEY ("tenant_id","inventory_item_id") REFERENCES "kliniva"."inventory_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_movements" ADD CONSTRAINT "stock_movements_from_fk" FOREIGN KEY ("tenant_id","from_location_id") REFERENCES "kliniva"."inventory_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_movements" ADD CONSTRAINT "stock_movements_to_fk" FOREIGN KEY ("tenant_id","to_location_id") REFERENCES "kliniva"."inventory_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_movements" ADD CONSTRAINT "stock_movements_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "kliniva"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_movements" ADD CONSTRAINT "stock_movements_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "kliniva"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_movements" ADD CONSTRAINT "stock_movements_usage_fk" FOREIGN KEY ("tenant_id","patient_usage_id") REFERENCES "kliniva"."patient_material_usages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_movements" ADD CONSTRAINT "stock_movements_lot_fk" FOREIGN KEY ("tenant_id","lot_id") REFERENCES "kliniva"."stock_lots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_items_tenant_name_idx" ON "kliniva"."inventory_items" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "patient_material_usages_patient_idx" ON "kliniva"."patient_material_usages" USING btree ("tenant_id","patient_id","created_at");--> statement-breakpoint
CREATE INDEX "patient_material_usages_appointment_idx" ON "kliniva"."patient_material_usages" USING btree ("tenant_id","appointment_id");--> statement-breakpoint
CREATE INDEX "stock_balances_location_idx" ON "kliniva"."stock_balances" USING btree ("tenant_id","location_id","inventory_item_id");--> statement-breakpoint
CREATE INDEX "stock_lots_expiry_idx" ON "kliniva"."stock_lots" USING btree ("tenant_id","expiry_date");--> statement-breakpoint
CREATE INDEX "stock_movements_item_idx" ON "kliniva"."stock_movements" USING btree ("tenant_id","inventory_item_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_movements_from_idx" ON "kliniva"."stock_movements" USING btree ("tenant_id","from_location_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_movements_to_idx" ON "kliniva"."stock_movements" USING btree ("tenant_id","to_location_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_movements_usage_idx" ON "kliniva"."stock_movements" USING btree ("tenant_id","patient_usage_id");--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD CONSTRAINT "clinic_profiles_negative_stock_ck" CHECK ("kliniva"."clinic_profiles"."allow_negative_stock" = false);