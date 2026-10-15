-- Sprint 5 lot / SKT. Güvenlik: Sprint 4'te kullanılmayan lot_id sütunları DÜŞÜRÜLMEDEN önce boş olduğu doğrulanır
-- (hiçbir hareketin anlamı değişmez; mevcut lotsuz ürünler trackLots=false kalır, sahte lot oluşturulmaz).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM kliniva.stock_movements WHERE lot_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM kliniva.patient_material_usage_items WHERE lot_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM kliniva.stock_lots) THEN
    RAISE EXCEPTION 'KLINIVA_MIGRATION_ABORT: lot data exists; manual lot migration required';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "kliniva"."patient_material_usage_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_usage_item_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"stock_lot_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pmu_alloc_uq" UNIQUE("tenant_id","patient_usage_item_id","stock_lot_id"),
	CONSTRAINT "pmu_alloc_quantity_ck" CHECK ("kliniva"."patient_material_usage_allocations"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usage_items" DROP CONSTRAINT "pmu_items_lot_fk";
--> statement-breakpoint
ALTER TABLE "kliniva"."stock_movements" DROP CONSTRAINT "stock_movements_lot_fk";
--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ALTER COLUMN "lot_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD COLUMN "expiry_warning_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ADD COLUMN "supplier_reference" text;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ADD COLUMN "recalled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ADD COLUMN "recalled_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ADD COLUMN "recall_reason_encrypted" text;--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usage_items" ADD CONSTRAINT "pmu_items_tenant_id_item_location_uq" UNIQUE("tenant_id","id","inventory_item_id","location_id");--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ADD CONSTRAINT "stock_lots_tenant_id_item_location_uq" UNIQUE("tenant_id","id","inventory_item_id","location_id");--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usage_allocations" ADD CONSTRAINT "pmu_alloc_item_fk" FOREIGN KEY ("tenant_id","patient_usage_item_id","inventory_item_id","location_id") REFERENCES "kliniva"."patient_material_usage_items"("tenant_id","id","inventory_item_id","location_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usage_allocations" ADD CONSTRAINT "pmu_alloc_lot_fk" FOREIGN KEY ("tenant_id","stock_lot_id","inventory_item_id","location_id") REFERENCES "kliniva"."stock_lots"("tenant_id","id","inventory_item_id","location_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pmu_alloc_lot_idx" ON "kliniva"."patient_material_usage_allocations" USING btree ("tenant_id","stock_lot_id");--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usage_items" DROP COLUMN "lot_id";--> statement-breakpoint
ALTER TABLE "kliniva"."stock_movements" DROP COLUMN "lot_id";--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ADD CONSTRAINT "stock_lots_identity_uq" UNIQUE("tenant_id","inventory_item_id","location_id","lot_number");--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" ADD CONSTRAINT "clinic_profiles_expiry_warning_ck" CHECK ("kliniva"."clinic_profiles"."expiry_warning_days" between 1 and 365);--> statement-breakpoint
ALTER TABLE "kliniva"."inventory_items" ADD CONSTRAINT "inventory_items_expiry_requires_lots_ck" CHECK (not "kliniva"."inventory_items"."track_expiry" or "kliniva"."inventory_items"."track_lots");--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ADD CONSTRAINT "stock_lots_number_ck" CHECK (length(trim("kliniva"."stock_lots"."lot_number")) between 1 and 64);