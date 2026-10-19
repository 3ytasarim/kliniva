-- Sprint 8.4 — tahliller güvenliği.
--  * lab_results değiştirilemez: UPDATE yalnızca ACTIVE → VOIDED (iptal alanları), DELETE yalnızca imha.
--  * Randevuya bağlı sonuçta hasta randevununkiyle aynı.
--  * RLS ENABLE + FORCE (iki tablo); uygulama rolü SELECT + INSERT + UPDATE.
CREATE OR REPLACE FUNCTION kliniva.lab_results_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  a_patient uuid;
  void_cols text[] := ARRAY['status', 'voided_at', 'voided_by_user_id', 'void_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: lab results cannot be deleted (void them)' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'ACTIVE' OR NEW.status <> 'VOIDED'
       OR (to_jsonb(NEW) - void_cols) IS DISTINCT FROM (to_jsonb(OLD) - void_cols) THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: lab results can only be voided once' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: lab results are created active' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.appointment_id IS NOT NULL THEN
    SELECT patient_id INTO a_patient FROM kliniva.appointments
     WHERE tenant_id = NEW.tenant_id AND id = NEW.appointment_id;
    IF a_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: lab result must match the appointment patient' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lab_results_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."lab_results"
  FOR EACH ROW EXECUTE FUNCTION kliniva.lab_results_guard();
--> statement-breakpoint
ALTER TABLE "kliniva"."lab_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."lab_results" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."lab_results"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."lab_panels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."lab_panels" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."lab_panels"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "kliniva"."lab_results", "kliniva"."lab_panels" TO kliniva_app;
