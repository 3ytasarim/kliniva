-- Sprint 7.3 — muayene kaydı (sağlık verisi) güvenliği.
--  * Yalnızca ekleme: UPDATE her zaman reddedilir; DELETE yalnızca yasal imha bağlamında (retention_purge).
--  * Tutarlılık: kaydın hastası / doktoru, randevunun hastası / doktoruyla AYNI olmalı (yanlış hastaya kayıt yazılamaz).
--  * Sürüm sırası: yeni sürüm = mevcut en büyük sürüm + 1 (araya / geriye sürüm eklenemez).
--  * RLS ENABLE + FORCE; uygulama rolü yalnızca SELECT + INSERT.
CREATE OR REPLACE FUNCTION kliniva.clinical_notes_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  a_patient uuid;
  a_doctor uuid;
  max_version integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: clinical notes are append-only' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: clinical notes are append-only (save a new version)' USING ERRCODE = 'P0001';
  END IF;
  SELECT patient_id, doctor_id INTO a_patient, a_doctor
    FROM kliniva.appointments WHERE tenant_id = NEW.tenant_id AND id = NEW.appointment_id;
  IF a_patient IS DISTINCT FROM NEW.patient_id OR a_doctor IS DISTINCT FROM NEW.doctor_id THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: clinical note must match the appointment patient and doctor' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(max(version), 0) INTO max_version
    FROM kliniva.clinical_notes WHERE tenant_id = NEW.tenant_id AND appointment_id = NEW.appointment_id;
  IF NEW.version <> max_version + 1 THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: clinical note version must be %', max_version + 1 USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER clinical_notes_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."clinical_notes"
  FOR EACH ROW EXECUTE FUNCTION kliniva.clinical_notes_guard();
--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_notes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."clinical_notes"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "kliniva"."clinical_notes" TO kliniva_app;
