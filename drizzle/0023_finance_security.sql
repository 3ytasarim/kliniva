-- Sprint 8 — hasta hesabı (hizmet bedeli) + kasa güvenliği.
--  * Değiştirilemez defter: UPDATE yalnızca ACTIVE → VOIDED (iptal zamanı / iptal eden / gerekçe) ve BAŞKA HİÇBİR
--    sütun değişmeden; iptal geri alınamaz. DELETE yalnızca yasal imha bağlamında (retention_purge).
--  * Tutarlılık: randevuya bağlı kayıtta hasta (ve hizmet bedelinde şube) randevununkiyle AYNI olmalı.
--  * RLS ENABLE + FORCE; uygulama rolü: defterlerde SELECT + INSERT + UPDATE (tetikleyiciyle sınırlı), DELETE yok.
CREATE OR REPLACE FUNCTION kliniva.finance_ledger_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  a_patient uuid;
  a_branch uuid;
  void_cols text[] := ARRAY['status', 'voided_at', 'voided_by_user_id', 'void_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: finance records cannot be deleted (void them)' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'ACTIVE' OR NEW.status <> 'VOIDED'
       OR (to_jsonb(NEW) - void_cols) IS DISTINCT FROM (to_jsonb(OLD) - void_cols) THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: finance records can only be voided once' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: finance records are created active' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.appointment_id IS NOT NULL THEN
    SELECT patient_id, branch_id INTO a_patient, a_branch
      FROM kliniva.appointments WHERE tenant_id = NEW.tenant_id AND id = NEW.appointment_id;
    IF a_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: finance record must match the appointment patient' USING ERRCODE = 'P0001';
    END IF;
    IF TG_TABLE_NAME = 'patient_charges' AND a_branch IS DISTINCT FROM NEW.branch_id THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: charge must match the appointment branch' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER patient_charges_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."patient_charges"
  FOR EACH ROW EXECUTE FUNCTION kliniva.finance_ledger_guard();
--> statement-breakpoint
CREATE TRIGGER cash_transactions_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."cash_transactions"
  FOR EACH ROW EXECUTE FUNCTION kliniva.finance_ledger_guard();
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_charges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_charges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."patient_charges"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."cash_transactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."cash_transactions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."cash_transactions"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."cash_categories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."cash_categories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."cash_categories"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "kliniva"."patient_charges", "kliniva"."cash_transactions", "kliniva"."cash_categories" TO kliniva_app;
