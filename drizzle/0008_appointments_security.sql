-- Kliniva AI — Sprint 3 randevu güvenliği (elle yazılır).
--   1. Çakışma motoru: aynı doktor / aynı oda / aynı hasta için örtüşen AKTİF randevu VERİTABANINDA imkânsız
--      (exclusion constraint, tstzrange yarı açık [başlangıç, bitiş) → bitişik randevular çakışmaz).
--      Aktif = BOOKED, CONFIRMED, CHECKED_IN, IN_PROGRESS, COMPLETED. CANCELLED / NO_SHOW / DRAFT slot tutmaz.
--   2. Durum makinesi tetikleyicisi: yalnızca izinli geçişler; tamamlanan / iptal / gelmedi kayıtları değişmez;
--      zaman/oda/doktor yalnızca DRAFT / BOOKED / CONFIRMED iken değişebilir; fiziksel silme yalnızca yasal imhada.
--   3. appointment_events yalnızca ekleme.
--   4. 4 yeni kiracı tablosunda RLS ENABLE + FORCE; kliniva_app için asgari yetki (DELETE yok).

-- ------------------------------------------------------------------ çakışma motoru
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_doctor_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =, doctor_id WITH =,
    tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
  ) WHERE (status IN ('BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'));
--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_room_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =, room_id WITH =,
    tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
  ) WHERE (room_id IS NOT NULL AND status IN ('BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'));
--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_patient_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =, patient_id WITH =,
    tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
  ) WHERE (status IN ('BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'));
--> statement-breakpoint

-- ------------------------------------------------------------------ durum makinesi
CREATE OR REPLACE FUNCTION kliniva.appointment_transition_allowed(
  from_s kliniva.appointment_status, to_s kliniva.appointment_status
) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE from_s
    WHEN 'DRAFT' THEN to_s IN ('BOOKED', 'CANCELLED')
    WHEN 'BOOKED' THEN to_s IN ('CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW')
    WHEN 'CONFIRMED' THEN to_s IN ('CHECKED_IN', 'CANCELLED', 'NO_SHOW')
    WHEN 'CHECKED_IN' THEN to_s IN ('IN_PROGRESS', 'CANCELLED')
    WHEN 'IN_PROGRESS' THEN to_s IN ('COMPLETED')
    ELSE false
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kliniva.appointments_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: appointments are never deleted (cancel instead)' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('DRAFT', 'BOOKED') THEN
      RAISE EXCEPTION 'KLINIVA_INVALID_TRANSITION: new appointment must be DRAFT or BOOKED' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.cancelled_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.no_show_at IS NOT NULL THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: terminal timestamps on insert' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.status IN ('COMPLETED', 'CANCELLED', 'NO_SHOW') THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: appointment is final (%)', OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: appointment identity columns' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT kliniva.appointment_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'KLINIVA_INVALID_TRANSITION: % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Zaman / doktor / oda / şube / hizmet yalnızca planlama aşamasında ve durum değişmeden değişebilir.
  IF NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end
     OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes OR NEW.doctor_id IS DISTINCT FROM OLD.doctor_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.service_id IS DISTINCT FROM OLD.service_id OR NEW.timezone IS DISTINCT FROM OLD.timezone THEN
    IF OLD.status NOT IN ('DRAFT', 'BOOKED', 'CONFIRMED') OR NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: schedule can only change while DRAFT/BOOKED/CONFIRMED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.status = 'CANCELLED' THEN
    IF NEW.cancelled_at IS NULL OR NEW.cancelled_by_user_id IS NULL THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: cancellation requires cancelled_at and cancelled_by_user_id' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by_user_id IS NOT NULL OR NEW.cancellation_reason IS NOT NULL THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: cancellation fields without CANCELLED' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'COMPLETED' AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: COMPLETED requires completed_at' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'NO_SHOW' AND NEW.no_show_at IS NULL THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: NO_SHOW requires no_show_at' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."appointments"
  FOR EACH ROW EXECUTE FUNCTION kliniva.appointments_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kliniva.appointment_events_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: appointment history is append-only' USING ERRCODE = 'P0001';
  END IF;
  IF NOT kliniva.retention_purge_enabled() THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: appointment history cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_events_guard BEFORE UPDATE OR DELETE ON "kliniva"."appointment_events"
  FOR EACH ROW EXECUTE FUNCTION kliniva.appointment_events_guard();
--> statement-breakpoint

-- ------------------------------------------------------------------ RLS (ENABLE + FORCE)
ALTER TABLE "kliniva"."clinical_services" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."clinical_services" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."clinical_services"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_services" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_services" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."doctor_services"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."appointments"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."appointment_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."appointment_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."appointment_events"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint

-- ------------------------------------------------------------------ kliniva_app yetkileri (en az yetki, DELETE yok)
GRANT SELECT, INSERT, UPDATE ON "kliniva"."clinical_services", "kliniva"."doctor_services",
  "kliniva"."appointments" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "kliniva"."appointment_events" TO kliniva_app;
