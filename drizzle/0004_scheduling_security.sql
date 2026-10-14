-- Kliniva AI — Sprint 1 güvenlik + çakışma motoru (elle yazılır).
--   1. btree_gist eklentisi KLINIVA şemasına kurulur (public'e dokunulmaz) → uuid/int eşitliği + aralık örtüşmesi
--      tek bir GiST exclusion constraint'te birleştirilebilir.
--   2. Exclusion constraint'ler: aynı doktor / aynı oda için örtüşen plan veritabanı seviyesinde İMKÂNSIZDIR
--      (eşzamanlı istekler dahil — race condition'a karşı son savunma hattı).
--   3. 8 yeni kiracı tablosunda RLS ENABLE + FORCE + tenant_isolation politikası.
--   4. kliniva_app için asgari yetkiler.
-- Zaman aralıkları yarı açık [başlangıç, bitiş) → 09:00–12:00 ile 12:00–15:00 bitişik, ÇAKIŞMAZ.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA "kliniva";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kliniva.minute_range(start_t time, end_t time) RETURNS int4range
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT int4range((extract(epoch FROM start_t) / 60)::int, (extract(epoch FROM end_t) / 60)::int, '[)') $$;
--> statement-breakpoint

-- ------------------------------------------------------------------ çakışma motoru (exclusion constraints)
-- Doktor aynı gün içinde (hangi şube olursa olsun) örtüşen iki çalışma bloğuna sahip olamaz.
ALTER TABLE "kliniva"."doctor_working_hours" ADD CONSTRAINT "doctor_working_hours_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =, doctor_id WITH =, day_of_week WITH =,
    kliniva.minute_range(start_time, end_time) WITH &&
  ) WHERE (active);
--> statement-breakpoint
-- Haftalık oda ataması: aynı oda aynı gün örtüşen iki atama alamaz.
ALTER TABLE "kliniva"."doctor_room_assignments" ADD CONSTRAINT "dra_room_weekly_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =, room_id WITH =, day_of_week WITH =,
    kliniva.minute_range(start_time, end_time) WITH &&
  ) WHERE (active AND day_of_week IS NOT NULL);
--> statement-breakpoint
-- Haftalık: aynı doktor aynı gün örtüşen iki odada olamaz.
ALTER TABLE "kliniva"."doctor_room_assignments" ADD CONSTRAINT "dra_doctor_weekly_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =, doctor_id WITH =, day_of_week WITH =,
    kliniva.minute_range(start_time, end_time) WITH &&
  ) WHERE (active AND day_of_week IS NOT NULL);
--> statement-breakpoint
-- Tarihli override: aynı oda aynı tarih örtüşen iki atama alamaz.
ALTER TABLE "kliniva"."doctor_room_assignments" ADD CONSTRAINT "dra_room_dated_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =, room_id WITH =, effective_date WITH =,
    kliniva.minute_range(start_time, end_time) WITH &&
  ) WHERE (active AND effective_date IS NOT NULL);
--> statement-breakpoint
-- Tarihli override: aynı doktor aynı tarih örtüşen iki odada olamaz.
ALTER TABLE "kliniva"."doctor_room_assignments" ADD CONSTRAINT "dra_doctor_dated_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =, doctor_id WITH =, effective_date WITH =,
    kliniva.minute_range(start_time, end_time) WITH &&
  ) WHERE (active AND effective_date IS NOT NULL);
--> statement-breakpoint

-- ------------------------------------------------------------------ RLS (ENABLE + FORCE)
ALTER TABLE "kliniva"."clinic_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."clinic_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."clinic_profiles"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."branch_working_hours" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."branch_working_hours" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."branch_working_hours"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."doctor_profiles"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_branches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_branches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."doctor_branches"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_working_hours" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_working_hours" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."doctor_working_hours"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_room_assignments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_room_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."doctor_room_assignments"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_schedule_exceptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."doctor_schedule_exceptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."doctor_schedule_exceptions"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."branch_closures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."branch_closures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."branch_closures"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint

-- ------------------------------------------------------------------ kliniva_app yetkileri (en az yetki)
-- Profil/doktor kayıtları: silme yok (pasifleştirme). Plan kayıtları (yapılandırma verisi): silinebilir.
GRANT SELECT, INSERT, UPDATE ON "kliniva"."clinic_profiles", "kliniva"."doctor_profiles" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "kliniva"."branch_working_hours", "kliniva"."doctor_branches",
  "kliniva"."doctor_working_hours", "kliniva"."doctor_room_assignments" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "kliniva"."doctor_schedule_exceptions", "kliniva"."branch_closures" TO kliniva_app;
