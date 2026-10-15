-- Kliniva AI — Sprint 4 stok güvenliği (elle yazılır).
--   1. DEFTER (stock_movements) kaynak gerçektir ve yalnızca eklenir: UPDATE hiç, DELETE yalnızca yasal imhada.
--   2. Bakiye (stock_balances) YALNIZCA defter tetikleyicisiyle güncellenir (SECURITY DEFINER). Uygulama rolü
--      bakiyeyi yalnızca okur → defter ile bakiye uygulama hatasıyla ayrışamaz.
--      Çıkış: koşullu UPDATE (quantity >= miktar); bulunamazsa KLINIVA_INSUFFICIENT_STOCK → hareket reddedilir.
--      Eşzamanlı istekler satır kilidiyle sıralanır; negatif stok ayrıca CHECK (quantity >= 0) ile imkânsız.
--   3. Hasta kullanımı: DRAFT → FINALIZED → VOIDED; FINALIZED kalemleri değişmez; VOIDED tamamen değişmez.
--   4. 9 yeni kiracı tablosunda RLS ENABLE + FORCE; kliniva_app için asgari yetki.

-- ------------------------------------------------------------------ defter → bakiye
CREATE OR REPLACE FUNCTION kliniva.stock_movements_apply() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, kliniva
AS $$
BEGIN
  IF NEW.from_location_id IS NOT NULL THEN
    UPDATE kliniva.stock_balances
       SET quantity = quantity - NEW.quantity, updated_at = now()
     WHERE tenant_id = NEW.tenant_id AND inventory_item_id = NEW.inventory_item_id
       AND location_id = NEW.from_location_id AND quantity >= NEW.quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'KLINIVA_INSUFFICIENT_STOCK' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.to_location_id IS NOT NULL THEN
    INSERT INTO kliniva.stock_balances (tenant_id, inventory_item_id, location_id, quantity)
    VALUES (NEW.tenant_id, NEW.inventory_item_id, NEW.to_location_id, NEW.quantity)
    ON CONFLICT (tenant_id, inventory_item_id, location_id)
    DO UPDATE SET quantity = kliniva.stock_balances.quantity + EXCLUDED.quantity, updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kliniva.stock_movements_apply() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER stock_movements_apply AFTER INSERT ON "kliniva"."stock_movements"
  FOR EACH ROW EXECUTE FUNCTION kliniva.stock_movements_apply();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kliniva.stock_movements_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: stock ledger is append-only (correct with a reverse movement)' USING ERRCODE = 'P0001';
  END IF;
  IF NOT kliniva.retention_purge_enabled() THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: stock movements cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_guard BEFORE UPDATE OR DELETE ON "kliniva"."stock_movements"
  FOR EACH ROW EXECUTE FUNCTION kliniva.stock_movements_guard();
--> statement-breakpoint

-- Uzlaştırma: bakiye önbelleğini defterden yeniden hesaplar (defter DEĞİŞMEZ). Yalnızca oturumdaki kiracı.
CREATE OR REPLACE FUNCTION kliniva.recompute_stock_balance(p_item uuid, p_location uuid)
RETURNS TABLE (previous numeric, recomputed numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, kliniva
AS $$
DECLARE
  t uuid := kliniva.current_tenant_id();
  ledger numeric;
  prev numeric;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'KLINIVA_NO_TENANT' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM kliniva.inventory_locations WHERE tenant_id = t AND id = p_location;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KLINIVA_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(sum(CASE WHEN m.to_location_id = p_location THEN m.quantity ELSE -m.quantity END), 0)
    INTO ledger
    FROM kliniva.stock_movements m
   WHERE m.tenant_id = t AND m.inventory_item_id = p_item
     AND (m.to_location_id = p_location OR m.from_location_id = p_location);
  SELECT b.quantity INTO prev FROM kliniva.stock_balances b
   WHERE b.tenant_id = t AND b.inventory_item_id = p_item AND b.location_id = p_location FOR UPDATE;
  IF prev IS NULL THEN
    IF ledger <> 0 THEN
      INSERT INTO kliniva.stock_balances (tenant_id, inventory_item_id, location_id, quantity)
      VALUES (t, p_item, p_location, ledger);
    END IF;
  ELSE
    UPDATE kliniva.stock_balances SET quantity = ledger, updated_at = now()
     WHERE tenant_id = t AND inventory_item_id = p_item AND location_id = p_location;
  END IF;
  RETURN QUERY SELECT coalesce(prev, 0), ledger;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kliniva.recompute_stock_balance(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kliniva.recompute_stock_balance(uuid, uuid) TO kliniva_app;
--> statement-breakpoint

-- ------------------------------------------------------------------ hasta kullanımı durum makinesi
CREATE OR REPLACE FUNCTION kliniva.patient_material_usages_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: material usage cannot be deleted (void instead)' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.finalized_at IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'KLINIVA_INVALID_TRANSITION: new usage must be DRAFT' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'VOIDED' THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: voided usage' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: usage identity columns' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'FINALIZED' THEN
    IF NEW.status <> 'VOIDED' THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: finalized usage can only be voided' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.appointment_id IS DISTINCT FROM OLD.appointment_id OR NEW.room_id IS DISTINCT FROM OLD.room_id
       OR NEW.doctor_id IS DISTINCT FROM OLD.doctor_id OR NEW.notes_encrypted IS DISTINCT FROM OLD.notes_encrypted
       OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at OR NEW.finalized_by_user_id IS DISTINCT FROM OLD.finalized_by_user_id THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: finalized usage evidence' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.status = 'FINALIZED' AND OLD.status = 'DRAFT'
     AND (NEW.finalized_at IS NULL OR NEW.finalized_by_user_id IS NULL) THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: FINALIZED requires finalized_at/by' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'VOIDED' AND (NEW.voided_at IS NULL OR NEW.voided_by_user_id IS NULL OR coalesce(trim(NEW.void_reason), '') = '') THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: VOIDED requires voided_at/by and reason' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'DRAFT' AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID_TRANSITION: back to DRAFT' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER patient_material_usages_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."patient_material_usages"
  FOR EACH ROW EXECUTE FUNCTION kliniva.patient_material_usages_guard();
--> statement-breakpoint
-- Kalemler yalnızca DRAFT kullanımda değişir; lokasyon kullanımın şubesinde olmak zorunda.
CREATE OR REPLACE FUNCTION kliniva.pmu_items_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  s kliniva.material_usage_status;
  usage_branch uuid;
  loc_branch uuid;
BEGIN
  IF TG_OP = 'DELETE' AND kliniva.retention_purge_enabled() THEN
    RETURN OLD;
  END IF;
  SELECT u.status, u.branch_id INTO s, usage_branch FROM kliniva.patient_material_usages u
   WHERE u.tenant_id = coalesce(NEW.tenant_id, OLD.tenant_id)
     AND u.id = coalesce(NEW.patient_usage_id, OLD.patient_usage_id);
  IF s IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: usage items can only change while DRAFT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.patient_usage_id IS DISTINCT FROM OLD.patient_usage_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id) THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: usage item identity' USING ERRCODE = 'P0001';
  END IF;
  SELECT l.branch_id INTO loc_branch FROM kliniva.inventory_locations l
   WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.location_id;
  IF loc_branch IS DISTINCT FROM usage_branch THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: stock location must belong to the usage branch' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pmu_items_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."patient_material_usage_items"
  FOR EACH ROW EXECUTE FUNCTION kliniva.pmu_items_guard();
--> statement-breakpoint

-- ------------------------------------------------------------------ RLS (ENABLE + FORCE)
ALTER TABLE "kliniva"."inventory_categories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."inventory_categories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."inventory_categories"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."inventory_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."inventory_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."inventory_items"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."inventory_locations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."inventory_locations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."inventory_locations"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."stock_balances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."stock_balances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."stock_balances"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."stock_lots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."stock_lots"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."stock_movements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."stock_movements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."stock_movements"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."patient_material_usages"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usage_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usage_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."patient_material_usage_items"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."service_material_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."service_material_templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."service_material_templates"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint

-- ------------------------------------------------------------------ kliniva_app yetkileri (en az yetki)
-- Katalog / lokasyon / kullanım: silme yok (pasifleştirme / VOID). Bakiye: YALNIZCA okuma (tetikleyici yazar).
-- Defter: okuma + ekleme. Kullanım kalemleri (DRAFT) ve şablonlar: yapılandırma verisi, silinebilir.
GRANT SELECT, INSERT, UPDATE ON "kliniva"."inventory_categories", "kliniva"."inventory_items",
  "kliniva"."inventory_locations", "kliniva"."stock_lots", "kliniva"."patient_material_usages" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT ON "kliniva"."stock_balances" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "kliniva"."stock_movements" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "kliniva"."patient_material_usage_items",
  "kliniva"."service_material_templates" TO kliniva_app;
