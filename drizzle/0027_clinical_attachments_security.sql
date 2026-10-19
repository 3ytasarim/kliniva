-- Sprint 8.2 — muayene dosyaları (sağlık verisi) güvenliği.
--  * Değiştirilemez: UPDATE yalnızca ACTIVE → VOIDED (iptal alanları), başka sütun değişmez; DELETE yalnızca imha.
--  * Tutarlılık: dosyanın hastası / doktoru randevununkiyle aynı; depolama anahtarı kiracının kendi önekinde.
--  * RLS ENABLE + FORCE; uygulama rolü SELECT + INSERT + UPDATE (tetikleyiciyle sınırlı), DELETE yok.
CREATE OR REPLACE FUNCTION kliniva.clinical_attachments_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  a_patient uuid;
  a_doctor uuid;
  void_cols text[] := ARRAY['status', 'voided_at', 'voided_by_user_id', 'void_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: clinical attachments cannot be deleted (void them)' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'ACTIVE' OR NEW.status <> 'VOIDED'
       OR (to_jsonb(NEW) - void_cols) IS DISTINCT FROM (to_jsonb(OLD) - void_cols) THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: clinical attachments can only be voided once' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: attachments are created active' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.storage_key NOT LIKE 'tenant/' || NEW.tenant_id::text || '/clinical/%' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: storage key must belong to the tenant' USING ERRCODE = 'P0001';
  END IF;
  SELECT patient_id, doctor_id INTO a_patient, a_doctor
    FROM kliniva.appointments WHERE tenant_id = NEW.tenant_id AND id = NEW.appointment_id;
  IF a_patient IS DISTINCT FROM NEW.patient_id OR a_doctor IS DISTINCT FROM NEW.doctor_id THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: attachment must match the appointment patient and doctor' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER clinical_attachments_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."clinical_attachments"
  FOR EACH ROW EXECUTE FUNCTION kliniva.clinical_attachments_guard();
--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_attachments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_attachments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."clinical_attachments"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "kliniva"."clinical_attachments" TO kliniva_app;
