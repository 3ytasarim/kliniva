-- Sprint 8.3 — hasta görevleri güvenliği.
--  * Kimlik sütunları değişmez (kiracı, hasta, oluşturan, oluşturma zamanı); kapanmış görev yeniden açılamaz ve
--    içeriği değişmez. DELETE yalnızca yasal imha bağlamında (görev iptal edilir, silinmez).
--  * Tutarlılık: randevuya bağlı görevde hasta randevununkiyle aynı.
--  * RLS ENABLE + FORCE; uygulama rolü SELECT + INSERT + UPDATE.
CREATE OR REPLACE FUNCTION kliniva.patient_tasks_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  a_patient uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: tasks are never deleted (cancel instead)' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: task identity columns' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status <> 'OPEN' THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: closed task cannot change' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'OPEN' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: tasks are created open' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.appointment_id IS NOT NULL THEN
    SELECT patient_id INTO a_patient FROM kliniva.appointments
     WHERE tenant_id = NEW.tenant_id AND id = NEW.appointment_id;
    IF a_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: task must match the appointment patient' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER patient_tasks_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."patient_tasks"
  FOR EACH ROW EXECUTE FUNCTION kliniva.patient_tasks_guard();
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_tasks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."patient_tasks"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "kliniva"."patient_tasks" TO kliniva_app;
