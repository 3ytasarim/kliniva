-- Kliniva AI — Sprint 6 güvenliği (elle yazılır).
--   1. Randevu durum makinesi + çakışma motoru: PENDING_APPROVAL slot TUTAR (exclusion constraint aktif listesinde);
--      geçişler PENDING_APPROVAL → BOOKED (doktor onayı) / CANCELLED (ret veya iptal). Yeni randevu
--      DRAFT / BOOKED / PENDING_APPROVAL ile başlayabilir.
--   2. Bildirim koruması: içerik (alıcı, tip, başlık, gövde, varlık, tekilleştirme anahtarı) değişmez; yalnızca
--      UNREAD → READ → ARCHIVED (veya UNREAD → ARCHIVED). Fiziksel silme yalnızca yasal imhada.
--   3. Outbox koruması: tip / toplam / yük / anahtar değişmez; izinli durum geçişleri; silme yok (imha hariç).
--   4. outbox_ready_tenants(): işlemcinin kiracı keşfi — SECURITY DEFINER, YALNIZCA kiracı kimlikleri döner
--      (olay içeriği RLS dışına çıkmaz); işleme her zaman kiracı bağlamında (RLS altında) yapılır.
--   5. 3 yeni tabloda RLS ENABLE + FORCE; kliniva_app için sütun düzeyinde en az yetki (DELETE yok).

-- ------------------------------------------------------------------ randevu durum makinesi
CREATE OR REPLACE FUNCTION kliniva.appointment_transition_allowed(
  from_s kliniva.appointment_status, to_s kliniva.appointment_status
) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE from_s
    WHEN 'DRAFT' THEN to_s IN ('BOOKED', 'CANCELLED')
    WHEN 'PENDING_APPROVAL' THEN to_s IN ('BOOKED', 'CANCELLED')
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
    IF NEW.status NOT IN ('DRAFT', 'BOOKED', 'PENDING_APPROVAL') THEN
      RAISE EXCEPTION 'KLINIVA_INVALID_TRANSITION: new appointment must be DRAFT, BOOKED or PENDING_APPROVAL' USING ERRCODE = 'P0001';
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
    IF OLD.status NOT IN ('DRAFT', 'BOOKED', 'CONFIRMED', 'PENDING_APPROVAL') OR NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: schedule can only change while DRAFT/PENDING_APPROVAL/BOOKED/CONFIRMED' USING ERRCODE = 'P0001';
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

-- ------------------------------------------------------------------ çakışma motoru (PENDING_APPROVAL dahil)
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_doctor_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =, doctor_id WITH =,
    tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
  ) WHERE (status IN ('PENDING_APPROVAL', 'BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'));
--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_room_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =, room_id WITH =,
    tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
  ) WHERE (room_id IS NOT NULL AND status IN ('PENDING_APPROVAL', 'BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'));
--> statement-breakpoint
ALTER TABLE "kliniva"."appointments" ADD CONSTRAINT "appointments_patient_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =, patient_id WITH =,
    tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
  ) WHERE (status IN ('PENDING_APPROVAL', 'BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'));
--> statement-breakpoint

-- ------------------------------------------------------------------ bildirim koruması
CREATE OR REPLACE FUNCTION kliniva.notifications_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: notifications are archived, never deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'UNREAD' OR NEW.read_at IS NOT NULL OR NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: new notification must be UNREAD' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.type IS DISTINCT FROM OLD.type OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.title IS DISTINCT FROM OLD.title OR NEW.body_safe IS DISTINCT FROM OLD.body_safe
     OR NEW.entity_type IS DISTINCT FROM OLD.entity_type OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.deduplication_key IS DISTINCT FROM OLD.deduplication_key
     OR NEW.metadata_safe IS DISTINCT FROM OLD.metadata_safe OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: notification content' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'UNREAD' AND NEW.status IN ('READ', 'ARCHIVED'))
       OR (OLD.status = 'READ' AND NEW.status = 'ARCHIVED')) THEN
    RAISE EXCEPTION 'KLINIVA_INVALID_TRANSITION: notification % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER notifications_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."notifications"
  FOR EACH ROW EXECUTE FUNCTION kliniva.notifications_guard();
--> statement-breakpoint

-- ------------------------------------------------------------------ outbox koruması
CREATE OR REPLACE FUNCTION kliniva.outbox_events_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: outbox events are not deleted (retention job only)' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.attempt_count <> 0 OR NEW.processed_at IS NOT NULL OR NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: new outbox event must be PENDING' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
     OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id OR NEW.payload_safe IS DISTINCT FROM OLD.payload_safe
     OR NEW.deduplication_key IS DISTINCT FROM OLD.deduplication_key OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: outbox event identity / payload' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('PROCESSING', 'PROCESSED', 'FAILED'))
       OR (OLD.status = 'PROCESSING' AND NEW.status IN ('PENDING', 'PROCESSED', 'FAILED'))
       OR (OLD.status = 'FAILED' AND NEW.status = 'PENDING')) THEN
    RAISE EXCEPTION 'KLINIVA_INVALID_TRANSITION: outbox % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count AND NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: attempt_count cannot decrease' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER outbox_events_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."outbox_events"
  FOR EACH ROW EXECUTE FUNCTION kliniva.outbox_events_guard();
--> statement-breakpoint

-- İşlemci kiracı keşfi: yalnızca kimlik döner; olay satırları her zaman kiracı bağlamında (RLS) okunur.
CREATE OR REPLACE FUNCTION kliniva.outbox_ready_tenants(p_limit integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, kliniva
AS $$
  SELECT tenant_id FROM (
    SELECT tenant_id, min(available_at) AS first_at
      FROM kliniva.outbox_events
     WHERE status = 'PENDING' AND available_at <= now()
     GROUP BY tenant_id
  ) t
  ORDER BY first_at
  LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kliniva.outbox_ready_tenants(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kliniva.outbox_ready_tenants(integer) TO kliniva_app;
--> statement-breakpoint

-- ------------------------------------------------------------------ RLS (ENABLE + FORCE)
ALTER TABLE "kliniva"."notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."notifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."notifications"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."notification_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."notification_preferences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."notification_preferences"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."outbox_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."outbox_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."outbox_events"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint

-- ------------------------------------------------------------------ yetkiler (en az yetki, DELETE yok)
GRANT SELECT, INSERT ON "kliniva"."notifications" TO kliniva_app;
--> statement-breakpoint
GRANT UPDATE (status, read_at, archived_at) ON "kliniva"."notifications" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "kliniva"."notification_preferences" TO kliniva_app;
--> statement-breakpoint
GRANT UPDATE (in_app_enabled, future_email_enabled, future_push_enabled, future_sms_enabled, future_whatsapp_enabled, updated_at)
  ON "kliniva"."notification_preferences" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "kliniva"."outbox_events" TO kliniva_app;
--> statement-breakpoint
GRANT UPDATE (status, attempt_count, available_at, processed_at, last_error_code)
  ON "kliniva"."outbox_events" TO kliniva_app;
