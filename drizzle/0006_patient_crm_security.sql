-- Kliniva AI — Sprint 2 güvenlik (elle yazılır).
--   1. patient_documents değiştirilemezlik kuralları genişletildi:
--        - İçerik snapshot'ı (content_snapshot_encrypted + content_sha256) ilk yazımdan sonra DEĞİŞMEZ.
--        - SIGNED → yalnızca VOIDED'a geçebilir ve bu geçişte yalnızca void alanları değişebilir.
--        - VOIDED tamamen değişmez. Geri dönüş (PRESENTED → DRAFT, SIGNED → DRAFT) yok.
--        - Yeni belge snapshot'sız eklenemez; SIGNED için PDF + imza + snapshot + hash + imzalayan türü zorunlu.
--   2. consent_revocations: yalnızca eklenir; aydınlatma (READ_AND_INFORMED) ve DENIED geri çekilemez.
--   3. patient_branches + consent_revocations için RLS ENABLE + FORCE ve kliniva_app yetkileri.
--   4. Geriye dönük veri: patient_branches (ana şubeden) ve normalize iletişim alanları.

CREATE OR REPLACE FUNCTION kliniva.patient_documents_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tpl_version integer;
  tpl_published timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('SIGNED', 'VOIDED') AND NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: signed/voided patient document cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT version, published_at INTO tpl_version, tpl_published
      FROM kliniva.document_templates WHERE id = NEW.document_template_id;
    IF tpl_version IS NULL OR tpl_published IS NULL OR tpl_version <> NEW.document_version THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: document must reference a published template version' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.content_snapshot_encrypted IS NULL OR NEW.content_sha256 IS NULL THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: document requires an immutable content snapshot' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'VOIDED' THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: voided patient document cannot be modified' USING ERRCODE = 'P0001';
    END IF;
    IF (NEW.tenant_id, NEW.patient_id, NEW.branch_id, NEW.document_template_id, NEW.document_version,
        NEW.created_by_user_id, NEW.generated_at)
       IS DISTINCT FROM
       (OLD.tenant_id, OLD.patient_id, OLD.branch_id, OLD.document_template_id, OLD.document_version,
        OLD.created_by_user_id, OLD.generated_at) THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: patient document identity columns cannot change' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.content_snapshot_encrypted IS NOT NULL AND (NEW.content_snapshot_encrypted, NEW.content_sha256)
       IS DISTINCT FROM (OLD.content_snapshot_encrypted, OLD.content_sha256) THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: document content snapshot cannot change' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status = 'PRESENTED' AND NEW.status = 'DRAFT' THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: document status cannot move backwards' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status = 'SIGNED' THEN
      IF NEW.status <> 'VOIDED' THEN
        RAISE EXCEPTION 'KLINIVA_IMMUTABLE: signed patient document cannot be modified' USING ERRCODE = 'P0001';
      END IF;
      -- SIGNED → VOIDED: yalnızca status + void alanları değişebilir; imza kanıtı aynen korunur.
      IF (NEW.presented_at, NEW.signed_at, NEW.signed_by_name, NEW.signer_type, NEW.guardian_name,
          NEW.guardian_relationship, NEW.signature_storage_key, NEW.pdf_storage_key, NEW.document_sha256)
         IS DISTINCT FROM
         (OLD.presented_at, OLD.signed_at, OLD.signed_by_name, OLD.signer_type, OLD.guardian_name,
          OLD.guardian_relationship, OLD.signature_storage_key, OLD.pdf_storage_key, OLD.document_sha256) THEN
        RAISE EXCEPTION 'KLINIVA_IMMUTABLE: signed document evidence cannot change' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  IF NEW.status = 'VOIDED' AND (NEW.voided_at IS NULL OR NEW.voided_by_user_id IS NULL
                                OR coalesce(btrim(NEW.void_reason), '') = '') THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: void requires voided_at, voided_by_user_id and void_reason' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'SIGNED' AND (
       NEW.signed_at IS NULL OR NEW.signed_by_name IS NULL OR NEW.signer_type IS NULL
    OR NEW.signature_storage_key IS NULL OR NEW.pdf_storage_key IS NULL OR NEW.document_sha256 IS NULL
    OR NEW.content_snapshot_encrypted IS NULL OR NEW.content_sha256 IS NULL
  ) THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: signed document requires signature evidence and snapshot' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- ------------------------------------------------------------------ açık rıza geri çekme
CREATE OR REPLACE FUNCTION kliniva.consent_revocations_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  choice_value kliniva.consent_value;
  doc_status kliniva.patient_document_status;
  doc_patient uuid;
  tpl_type kliniva.document_type;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: consent revocation is append-only' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: consent revocation cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  SELECT c.value, d.status, d.patient_id, t.type INTO choice_value, doc_status, doc_patient, tpl_type
    FROM kliniva.consent_choices c
    JOIN kliniva.patient_documents d ON d.id = c.patient_document_id AND d.tenant_id = c.tenant_id
    JOIN kliniva.document_templates t ON t.id = d.document_template_id
   WHERE c.id = NEW.consent_choice_id AND c.tenant_id = NEW.tenant_id;

  IF choice_value IS NULL THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: unknown consent choice' USING ERRCODE = 'P0001';
  END IF;
  IF tpl_type = 'KVKK_DISCLOSURE' OR choice_value = 'READ_AND_INFORMED' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: disclosure acknowledgement cannot be revoked' USING ERRCODE = 'P0001';
  END IF;
  IF choice_value <> 'GRANTED' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: only a granted consent can be revoked' USING ERRCODE = 'P0001';
  END IF;
  IF doc_status <> 'SIGNED' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: consent must belong to a signed document' USING ERRCODE = 'P0001';
  END IF;
  IF doc_patient <> NEW.patient_id THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: consent belongs to another patient' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER consent_revocations_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."consent_revocations"
  FOR EACH ROW EXECUTE FUNCTION kliniva.consent_revocations_guard();
--> statement-breakpoint

-- ------------------------------------------------------------------ RLS (ENABLE + FORCE)
ALTER TABLE "kliniva"."patient_branches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_branches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."patient_branches"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."consent_revocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."consent_revocations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."consent_revocations"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint

-- ------------------------------------------------------------------ kliniva_app yetkileri (en az yetki)
GRANT SELECT, INSERT, UPDATE ON "kliniva"."patient_branches" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "kliniva"."consent_revocations" TO kliniva_app;
--> statement-breakpoint

-- ------------------------------------------------------------------ geriye dönük veri
-- Mevcut hastaların ana şubesi patient_branches'a taşınır (şube kapsamı artık bu tablodan hesaplanır).
INSERT INTO "kliniva"."patient_branches" (tenant_id, patient_id, branch_id, first_seen_at, last_seen_at)
SELECT p.tenant_id, p.id, p.branch_id, p.created_at, p.updated_at
  FROM "kliniva"."patients" p
 WHERE p.branch_id IS NOT NULL
ON CONFLICT (tenant_id, patient_id, branch_id) DO NOTHING;
--> statement-breakpoint
-- Normalize iletişim alanları (TR varsayımı; uygulama yeni kayıtları ülke farkındalıklı yardımcıyla yazar).
UPDATE "kliniva"."patients" SET
  email_normalized = CASE WHEN email IS NULL THEN NULL ELSE lower(btrim(email)) END,
  phone_normalized = CASE
    WHEN regexp_replace(phone, '\D', '', 'g') ~ '^05\d{9}$' THEN '+9' || regexp_replace(phone, '\D', '', 'g')
    WHEN regexp_replace(phone, '\D', '', 'g') ~ '^5\d{9}$' THEN '+90' || regexp_replace(phone, '\D', '', 'g')
    WHEN regexp_replace(phone, '\D', '', 'g') ~ '^905\d{9}$' THEN '+' || regexp_replace(phone, '\D', '', 'g')
    ELSE NULL
  END
 WHERE phone_normalized IS NULL;
