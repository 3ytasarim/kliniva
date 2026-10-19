-- Sprint 8.1 — hasta tanımları (kaynak / sigorta) güvenliği.
--  * patient_lookups: RLS ENABLE + FORCE; uygulama rolü SELECT + INSERT + UPDATE (silme yok; pasifleştirilir).
--  * Hastanın source_id'si SOURCE, insurer_id'si INSURER türünde bir tanıma işaret etmeli (yanlış tür reddedilir).
CREATE OR REPLACE FUNCTION kliniva.patients_lookup_kind_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM kliniva.patient_lookups l
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.source_id AND l.kind = 'SOURCE') THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: patient source must be a SOURCE lookup' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.insurer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM kliniva.patient_lookups l
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.insurer_id AND l.kind = 'INSURER') THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: patient insurer must be an INSURER lookup' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER patients_lookup_kind_guard BEFORE INSERT OR UPDATE OF source_id, insurer_id ON "kliniva"."patients"
  FOR EACH ROW EXECUTE FUNCTION kliniva.patients_lookup_kind_guard();
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_lookups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_lookups" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."patient_lookups"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "kliniva"."patient_lookups" TO kliniva_app;
