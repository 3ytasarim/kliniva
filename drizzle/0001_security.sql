-- Kliniva AI — güvenlik migration'ı (elle yazılır, drizzle-kit generate --custom).
--   1. Satır düzeyi güvenlik (RLS, FORCE): kiracı tabloları yalnızca transaction içinde ayarlanan
--      app.tenant_id bağlamıyla görünür. Bağlam yoksa hiçbir satır görünmez / yazılamaz.
--   2. Değiştirilemezlik: audit_logs yalnızca eklenir; SIGNED hasta belgesi ve seçimleri değiştirilemez;
--      yayımlanmış belge şablonunun metni değiştirilemez (yeni metin = yeni versiyon).
--   3. Aydınlatma ≠ açık rıza: KVKK_DISCLOSURE belgesinde yalnızca READ_AND_INFORMED kaydedilebilir.
-- Silme yalnızca yasal saklama süresi dolduğunda, transaction içinde kliniva.retention_purge = 'on'
-- ayarlanarak yapılabilir (bkz. docs/KVKK_ARCHITECTURE.md → Saklama ve imha).
-- Her ifade ayrı statement-breakpoint ile bölünür (Neon pooler çok-ifadeli sorgu sorunlarından kaçınmak için).

CREATE OR REPLACE FUNCTION kliniva.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kliniva.retention_purge_enabled() RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT COALESCE(current_setting('kliniva.retention_purge', true), '') = 'on' $$;
--> statement-breakpoint

-- ------------------------------------------------------------------ RLS: standart kiracı tabloları
ALTER TABLE "kliniva"."branches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."branches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."branches"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."rooms" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."rooms" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."rooms"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."users"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."user_roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."user_roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."user_roles"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."patients" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."patients" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."patients"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."audit_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."audit_logs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."audit_logs"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."patient_documents"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."consent_choices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."consent_choices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."consent_choices"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint

-- ------------------------------------------------------------------ RLS: platform + kiracı satırı olan tablolar
-- Platform satırları (tenant_id NULL) herkes tarafından OKUNUR, ama kiracı bağlamından yazılamaz/silinemez.
ALTER TABLE "kliniva"."document_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."document_templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY platform_or_tenant_read ON "kliniva"."document_templates" FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_write ON "kliniva"."document_templates" FOR ALL
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY platform_or_tenant_read ON "kliniva"."roles" FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_write ON "kliniva"."roles" FOR ALL
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
-- Sistem rollerinin kurulumu (seed) yalnızca kliniva.platform_seed = 'on' bağlamında yapılabilir.
CREATE POLICY platform_seed ON "kliniva"."roles" FOR ALL
  USING (tenant_id IS NULL AND COALESCE(current_setting('kliniva.platform_seed', true), '') = 'on')
  WITH CHECK (tenant_id IS NULL AND COALESCE(current_setting('kliniva.platform_seed', true), '') = 'on');
--> statement-breakpoint
CREATE POLICY platform_seed ON "kliniva"."document_templates" FOR ALL
  USING (tenant_id IS NULL AND COALESCE(current_setting('kliniva.platform_seed', true), '') = 'on')
  WITH CHECK (tenant_id IS NULL AND COALESCE(current_setting('kliniva.platform_seed', true), '') = 'on');
--> statement-breakpoint

-- ------------------------------------------------------------------ audit_logs: yalnızca ekleme
CREATE OR REPLACE FUNCTION kliniva.audit_logs_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: audit_logs is append-only' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' AND NOT kliniva.retention_purge_enabled() THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: audit_logs delete requires retention purge' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_guard BEFORE UPDATE OR DELETE ON "kliniva"."audit_logs"
  FOR EACH ROW EXECUTE FUNCTION kliniva.audit_logs_guard();
--> statement-breakpoint

-- ------------------------------------------------------------------ belge şablonu: yayımlandıktan sonra değişmez
CREATE OR REPLACE FUNCTION kliniva.document_templates_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL AND NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: published template cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.published_at IS NOT NULL AND (
       NEW.content IS DISTINCT FROM OLD.content
    OR NEW.choices IS DISTINCT FROM OLD.choices
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
  ) THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: published template is immutable; create a new version' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER document_templates_guard BEFORE UPDATE OR DELETE ON "kliniva"."document_templates"
  FOR EACH ROW EXECUTE FUNCTION kliniva.document_templates_guard();
--> statement-breakpoint

-- ------------------------------------------------------------------ hasta belgesi: imzalandıktan sonra değişmez
CREATE OR REPLACE FUNCTION kliniva.patient_documents_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tpl_version integer;
  tpl_published timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'SIGNED' AND NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: signed patient document cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('SIGNED', 'VOIDED') THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: signed/voided patient document cannot be modified' USING ERRCODE = 'P0001';
    END IF;
    IF (NEW.tenant_id, NEW.patient_id, NEW.branch_id, NEW.document_template_id, NEW.document_version,
        NEW.created_by_user_id, NEW.generated_at)
       IS DISTINCT FROM
       (OLD.tenant_id, OLD.patient_id, OLD.branch_id, OLD.document_template_id, OLD.document_version,
        OLD.created_by_user_id, OLD.generated_at) THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: patient document identity columns cannot change' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT version, published_at INTO tpl_version, tpl_published
      FROM kliniva.document_templates WHERE id = NEW.document_template_id;
    IF tpl_version IS NULL OR tpl_published IS NULL OR tpl_version <> NEW.document_version THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: document must reference a published template version' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.status = 'SIGNED' AND (
       NEW.signed_at IS NULL OR NEW.signed_by_name IS NULL
    OR NEW.signature_storage_key IS NULL OR NEW.document_sha256 IS NULL
  ) THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: signed document requires signature evidence' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER patient_documents_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."patient_documents"
  FOR EACH ROW EXECUTE FUNCTION kliniva.patient_documents_guard();
--> statement-breakpoint

-- ------------------------------------------------------------------ seçimler: imzadan sonra değişmez; aydınlatma ≠ rıza
CREATE OR REPLACE FUNCTION kliniva.consent_choices_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  doc_status kliniva.patient_document_status;
  tpl_type kliniva.document_type;
  doc_id uuid;
BEGIN
  doc_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.patient_document_id ELSE NEW.patient_document_id END;
  SELECT d.status, t.type INTO doc_status, tpl_type
    FROM kliniva.patient_documents d
    JOIN kliniva.document_templates t ON t.id = d.document_template_id
   WHERE d.id = doc_id;

  IF doc_status IN ('SIGNED', 'VOIDED') THEN
    IF TG_OP <> 'DELETE' OR NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: choices of a signed document cannot change' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF tpl_type = 'KVKK_DISCLOSURE' AND NEW.value <> 'READ_AND_INFORMED' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: disclosure documents only record READ_AND_INFORMED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER consent_choices_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."consent_choices"
  FOR EACH ROW EXECUTE FUNCTION kliniva.consent_choices_guard();
