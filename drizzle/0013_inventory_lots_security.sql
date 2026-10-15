-- Kliniva AI — Sprint 5 lot / SKT güvenliği (elle yazılır).
--   1. Defter → bakiye tetikleyicisi lot bakiyesini de AYNI satırda günceller (lokasyon + lot birlikte; biri
--      başarısızsa hareket reddedilir). Lot bakiyesi de önbellektir; kaynak gerçek defterdir.
--   2. Hareket lot koruması: lot takipli üründe her konum değişimi lot taşımak ZORUNDA; lotsuz üründe lot YASAK;
--      transferde lot kimliği (numara + SKT) korunur; hasta kullanımında süresi geçmiş / geri çağrılmış / pasif
--      lot VERİTABANINDA reddedilir (eşzamanlı geri çağırma yarışına karşı son savunma).
--      SKT anlamı: DATE; lotun bulunduğu şubenin yerel takviminde o günün SONUNA kadar geçerli.
--   3. Lot satırı: oluşturulurken miktar 0; numara / ürün / lokasyon değişmez; geri çağırma geri alınamaz;
--      uygulama rolünün miktar sütununa UPDATE yetkisi YOK (yalnızca tetikleyici).
--   4. Tahsisler yalnızca DRAFT kullanımda değişir. RLS ENABLE + FORCE; asgari yetki.

-- ------------------------------------------------------------------ defter → bakiye (lokasyon + lot)
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
    IF NEW.from_stock_lot_id IS NOT NULL THEN
      UPDATE kliniva.stock_lots
         SET quantity = quantity - NEW.quantity, updated_at = now()
       WHERE tenant_id = NEW.tenant_id AND id = NEW.from_stock_lot_id AND quantity >= NEW.quantity;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'KLINIVA_INSUFFICIENT_STOCK' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  IF NEW.to_location_id IS NOT NULL THEN
    INSERT INTO kliniva.stock_balances (tenant_id, inventory_item_id, location_id, quantity)
    VALUES (NEW.tenant_id, NEW.inventory_item_id, NEW.to_location_id, NEW.quantity)
    ON CONFLICT (tenant_id, inventory_item_id, location_id)
    DO UPDATE SET quantity = kliniva.stock_balances.quantity + EXCLUDED.quantity, updated_at = now();
    IF NEW.to_stock_lot_id IS NOT NULL THEN
      UPDATE kliniva.stock_lots
         SET quantity = quantity + NEW.quantity, updated_at = now()
       WHERE tenant_id = NEW.tenant_id AND id = NEW.to_stock_lot_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'KLINIVA_INVALID: unknown destination lot' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kliniva.stock_movements_apply() FROM PUBLIC;
--> statement-breakpoint

-- Lot süresi geçmiş mi? Lokasyonun şubesinin yerel takvimine göre: SKT günü boyunca geçerli.
CREATE OR REPLACE FUNCTION kliniva.lot_expired(p_expiry date, p_tenant uuid, p_location uuid) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT p_expiry IS NOT NULL AND p_expiry < (now() AT TIME ZONE b.timezone)::date
    FROM kliniva.inventory_locations l
    JOIN kliniva.branches b ON b.tenant_id = l.tenant_id AND b.id = l.branch_id
   WHERE l.tenant_id = p_tenant AND l.id = p_location
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION kliniva.stock_movements_lot_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lots boolean;
  f record;
  t record;
BEGIN
  SELECT i.track_lots INTO lots FROM kliniva.inventory_items i
   WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.inventory_item_id;
  IF lots THEN
    IF (NEW.from_location_id IS NOT NULL AND NEW.from_stock_lot_id IS NULL)
       OR (NEW.to_location_id IS NOT NULL AND NEW.to_stock_lot_id IS NULL) THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: lot-tracked movement requires lot' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.from_stock_lot_id IS NOT NULL OR NEW.to_stock_lot_id IS NOT NULL THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: lot on non lot-tracked item' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.from_stock_lot_id IS NOT NULL THEN
    SELECT * INTO f FROM kliniva.stock_lots WHERE tenant_id = NEW.tenant_id AND id = NEW.from_stock_lot_id;
    IF NEW.movement_type IN ('PATIENT_USAGE', 'TRANSFER') AND f.recalled_at IS NOT NULL THEN
      RAISE EXCEPTION 'KLINIVA_LOT_RECALLED' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.movement_type = 'PATIENT_USAGE' THEN
      IF NOT f.active THEN
        RAISE EXCEPTION 'KLINIVA_LOT_INACTIVE' USING ERRCODE = 'P0001';
      END IF;
      IF kliniva.lot_expired(f.expiry_date, NEW.tenant_id, NEW.from_location_id) THEN
        RAISE EXCEPTION 'KLINIVA_LOT_EXPIRED' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  IF NEW.movement_type = 'TRANSFER' AND NEW.from_stock_lot_id IS NOT NULL THEN
    SELECT * INTO t FROM kliniva.stock_lots WHERE tenant_id = NEW.tenant_id AND id = NEW.to_stock_lot_id;
    IF t.lot_number IS DISTINCT FROM f.lot_number OR t.expiry_date IS DISTINCT FROM f.expiry_date THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: transfer must preserve lot identity' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_lot_guard BEFORE INSERT ON "kliniva"."stock_movements"
  FOR EACH ROW EXECUTE FUNCTION kliniva.stock_movements_lot_guard();
--> statement-breakpoint

-- ------------------------------------------------------------------ lot satırı koruması
CREATE OR REPLACE FUNCTION kliniva.stock_lots_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  it record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: stock lots cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT i.track_lots, i.track_expiry INTO it FROM kliniva.inventory_items i
     WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.inventory_item_id;
    IF NOT coalesce(it.track_lots, false) THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: item is not lot-tracked' USING ERRCODE = 'P0001';
    END IF;
    IF it.track_expiry AND NEW.expiry_date IS NULL THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: expiry date required' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.quantity <> 0 OR NEW.recalled_at IS NOT NULL THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: new lot starts empty (stock only via ledger)' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.lot_number IS DISTINCT FROM OLD.lot_number OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: lot identity' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.recalled_at IS NOT NULL AND (NEW.recalled_at IS DISTINCT FROM OLD.recalled_at
     OR NEW.recalled_by_user_id IS DISTINCT FROM OLD.recalled_by_user_id
     OR NEW.recall_reason_encrypted IS DISTINCT FROM OLD.recall_reason_encrypted) THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: recall cannot be changed or undone' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.recalled_at IS NOT NULL AND (NEW.recalled_by_user_id IS NULL OR NEW.recall_reason_encrypted IS NULL) THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: recall requires actor and reason' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_lots_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."stock_lots"
  FOR EACH ROW EXECUTE FUNCTION kliniva.stock_lots_guard();
--> statement-breakpoint

-- Uzlaştırma: lot önbelleğini defterden yeniden hesaplar (defter DEĞİŞMEZ). Yalnızca oturumdaki kiracı.
CREATE OR REPLACE FUNCTION kliniva.recompute_stock_lot(p_lot uuid)
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
  SELECT l.quantity INTO prev FROM kliniva.stock_lots l WHERE l.tenant_id = t AND l.id = p_lot FOR UPDATE;
  IF prev IS NULL THEN
    RAISE EXCEPTION 'KLINIVA_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(sum(CASE WHEN m.to_stock_lot_id = p_lot THEN m.quantity ELSE -m.quantity END), 0)
    INTO ledger
    FROM kliniva.stock_movements m
   WHERE m.tenant_id = t AND (m.to_stock_lot_id = p_lot OR m.from_stock_lot_id = p_lot);
  UPDATE kliniva.stock_lots SET quantity = ledger, updated_at = now() WHERE tenant_id = t AND id = p_lot;
  RETURN QUERY SELECT prev, ledger;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kliniva.recompute_stock_lot(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kliniva.recompute_stock_lot(uuid) TO kliniva_app;
--> statement-breakpoint

-- ------------------------------------------------------------------ tahsis koruması (yalnızca DRAFT)
CREATE OR REPLACE FUNCTION kliniva.pmu_alloc_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  s kliniva.material_usage_status;
BEGIN
  IF TG_OP = 'DELETE' AND kliniva.retention_purge_enabled() THEN
    RETURN OLD;
  END IF;
  SELECT u.status INTO s
    FROM kliniva.patient_material_usage_items i
    JOIN kliniva.patient_material_usages u ON u.tenant_id = i.tenant_id AND u.id = i.patient_usage_id
   WHERE i.tenant_id = coalesce(NEW.tenant_id, OLD.tenant_id)
     AND i.id = coalesce(NEW.patient_usage_item_id, OLD.patient_usage_item_id);
  IF s IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: allocations can only change while usage is DRAFT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pmu_alloc_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."patient_material_usage_allocations"
  FOR EACH ROW EXECUTE FUNCTION kliniva.pmu_alloc_guard();
--> statement-breakpoint

-- ------------------------------------------------------------------ RLS (ENABLE + FORCE)
ALTER TABLE "kliniva"."patient_material_usage_allocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_material_usage_allocations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."patient_material_usage_allocations"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint

-- ------------------------------------------------------------------ yetkiler (en az yetki)
-- Lot: tablo düzeyi UPDATE kaldırılır; yalnızca meta veri / geri çağırma sütunları güncellenebilir (miktar,
-- numara, ürün, lokasyon DEĞİL).
REVOKE UPDATE ON "kliniva"."stock_lots" FROM kliniva_app;
--> statement-breakpoint
GRANT UPDATE (expiry_date, active, supplier_reference, recalled_at, recalled_by_user_id, recall_reason_encrypted, updated_at)
  ON "kliniva"."stock_lots" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "kliniva"."patient_material_usage_allocations" TO kliniva_app;
