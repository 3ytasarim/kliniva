-- Kliniva AI — en az yetkili uygulama rolü (kliniva_app) ve yetki matrisi.
--
-- Migration'ları şema sahibi rol (MIGRATION_DATABASE_URL) çalıştırır; uygulama çalışma anında kliniva_app ile
-- bağlanır (DATABASE_URL). kliniva_app:
--   - SUPERUSER / BYPASSRLS / CREATEDB / CREATEROLE / REPLICATION DEĞİLDİR (varsayılanlar; aşağıda doğrulanır)
--   - kliniva tablolarının SAHİBİ DEĞİLDİR → RLS her zaman uygulanır
--   - kliniva şemasında CREATE yetkisi yoktur; public şemasına yetki verilmez
--   - audit_logs / consent_choices / patient_documents üzerinde DELETE yetkisi yoktur
-- Rol burada NOLOGIN oluşturulur. Parola ve LOGIN, `npm run db:app-role` ile (SCRAM özeti olarak) ayarlanır;
-- parola hiçbir migration dosyasında yer almaz.

DO $$
DECLARE
  r record;
BEGIN
  SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication INTO r
    FROM pg_roles WHERE rolname = 'kliniva_app';
  IF NOT FOUND THEN
    CREATE ROLE kliniva_app NOLOGIN NOINHERIT;
  ELSIF r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication THEN
    RAISE EXCEPTION 'KLINIVA_UNSAFE_ROLE: existing kliniva_app role has elevated attributes';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "kliniva" TO kliniva_app;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "kliniva" FROM kliniva_app;
--> statement-breakpoint
-- Platform katalogları: yalnızca okuma (RBAC kataloğu seed ile, migration rolüyle yazılır).
GRANT SELECT ON "kliniva"."permissions", "kliniva"."role_permissions", "kliniva"."roles" TO kliniva_app;
--> statement-breakpoint
-- Kiracı kaydı: okuma + yalnızca hasta numarası sayacının artırılması. Kiracı oluşturma/silme platform işlemidir.
GRANT SELECT ON "kliniva"."tenants" TO kliniva_app;
--> statement-breakpoint
GRANT UPDATE ("patient_seq", "updated_at") ON "kliniva"."tenants" TO kliniva_app;
--> statement-breakpoint
-- Oturumlar: iptal = UPDATE revoked_at (silme yok, iz kalır).
GRANT SELECT, INSERT, UPDATE ON "kliniva"."sessions" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "kliniva"."rate_limits" TO kliniva_app;
--> statement-breakpoint
-- Kiracı tabloları (RLS FORCE): silme yerine pasifleştirme.
GRANT SELECT, INSERT, UPDATE ON "kliniva"."branches", "kliniva"."rooms", "kliniva"."users", "kliniva"."patients" TO kliniva_app;
--> statement-breakpoint
-- Rol atamalarının değiştirilmesi = sil + ekle.
GRANT SELECT, INSERT, DELETE ON "kliniva"."user_roles" TO kliniva_app;
--> statement-breakpoint
-- Audit: yalnızca okuma ve ekleme.
GRANT SELECT, INSERT ON "kliniva"."audit_logs" TO kliniva_app;
--> statement-breakpoint
-- KVKK: şablon (yayın sonrası değişmez — tetikleyici), belge (imza sonrası değişmez), seçimler (yalnızca ekleme).
GRANT SELECT, INSERT, UPDATE ON "kliniva"."document_templates", "kliniva"."patient_documents" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "kliniva"."consent_choices" TO kliniva_app;
--> statement-breakpoint

-- ------------------------------------------------------------------ PLATFORM_SUPER_ADMIN kiracı içinde atanamaz
CREATE OR REPLACE FUNCTION kliniva.user_roles_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  role_key text;
  role_tenant uuid;
BEGIN
  SELECT key, tenant_id INTO role_key, role_tenant FROM kliniva.roles WHERE id = NEW.role_id;
  IF role_key IS NULL THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: unknown role' USING ERRCODE = 'P0001';
  END IF;
  IF role_key = 'PLATFORM_SUPER_ADMIN' THEN
    RAISE EXCEPTION 'KLINIVA_FORBIDDEN: PLATFORM_SUPER_ADMIN cannot be assigned inside a tenant' USING ERRCODE = 'P0001';
  END IF;
  IF role_tenant IS NOT NULL AND role_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'KLINIVA_FORBIDDEN: role belongs to another tenant' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER user_roles_guard BEFORE INSERT OR UPDATE ON "kliniva"."user_roles"
  FOR EACH ROW EXECUTE FUNCTION kliniva.user_roles_guard();
