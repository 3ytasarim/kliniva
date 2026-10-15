-- Kliniva AI — Sprint 7 sesli asistan güvenliği (elle yazılır).
--   1. pending_ai_actions: kimlik / girdi / bütünlük özeti / oturum DEĞİŞMEZ; durum yalnızca ileri gider
--      (PENDING → CONFIRMED | EXPIRED | CANCELLED; CONFIRMED → EXECUTED | FAILED); son durumlar değişmez, tekrar
--      PENDING'e dönülemez. Etkin (PENDING / CONFIRMED / EXECUTED) eylemler için idempotency_key kiracı içinde tek
--      (kısmi benzersiz indeks) → yinelenen araç çağrısı ikinci iş eylemi üretmez.
--   2. ai_action_logs: kimlik / araç / oturum değişmez; son durumlar (SUCCEEDED / FAILED / CANCELLED) değişmez.
--   3. voice_sessions: kimlik değişmez; ENDED / EXPIRED / FAILED son durumdur.
--   4. Silme yok (yalnızca yasal imha). 3 tabloda RLS ENABLE + FORCE; kliniva_app için sütun düzeyi en az yetki.

CREATE UNIQUE INDEX "pending_ai_actions_idempotency_uq" ON "kliniva"."pending_ai_actions" ("tenant_id", "idempotency_key")
  WHERE status IN ('PENDING', 'CONFIRMED', 'EXECUTED');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION kliniva.pending_ai_actions_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: pending AI actions are not deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.confirmed_at IS NOT NULL OR NEW.executed_at IS NOT NULL
       OR NEW.result_entity_id IS NOT NULL OR NEW.result_code IS NOT NULL THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: new AI action must be PENDING' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.voice_session_id IS DISTINCT FROM OLD.voice_session_id
     OR NEW.tool_name IS DISTINCT FROM OLD.tool_name OR NEW.safe_input_hash IS DISTINCT FROM OLD.safe_input_hash
     OR NEW.input_encrypted IS DISTINCT FROM OLD.input_encrypted OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.ai_action_log_id IS NOT NULL AND NEW.ai_action_log_id IS DISTINCT FROM OLD.ai_action_log_id) THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: AI action identity / input' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('EXECUTED', 'FAILED', 'EXPIRED', 'CANCELLED') AND (
       NEW.status IS DISTINCT FROM OLD.status OR NEW.result_entity_id IS DISTINCT FROM OLD.result_entity_id
       OR NEW.result_code IS DISTINCT FROM OLD.result_code OR NEW.executed_at IS DISTINCT FROM OLD.executed_at
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: AI action is final (%)', OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('CONFIRMED', 'EXPIRED', 'CANCELLED'))
       OR (OLD.status = 'CONFIRMED' AND NEW.status IN ('EXECUTED', 'FAILED'))) THEN
    RAISE EXCEPTION 'KLINIVA_INVALID_TRANSITION: AI action % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'CONFIRMED' AND NEW.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: CONFIRMED requires confirmed_at' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'EXECUTED' AND NEW.executed_at IS NULL THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: EXECUTED requires executed_at' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pending_ai_actions_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."pending_ai_actions"
  FOR EACH ROW EXECUTE FUNCTION kliniva.pending_ai_actions_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION kliniva.ai_action_logs_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: AI action logs are append-only' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.voice_session_id IS DISTINCT FROM OLD.voice_session_id
     OR NEW.tool_name IS DISTINCT FROM OLD.tool_name OR NEW.action_type IS DISTINCT FROM OLD.action_type
     OR NEW.confirmation_required IS DISTINCT FROM OLD.confirmation_required OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: AI action log identity' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: AI action log is final (%)', OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'REQUESTED' AND NEW.status IN ('CONFIRMED', 'SUCCEEDED', 'FAILED', 'CANCELLED'))
       OR (OLD.status = 'CONFIRMED' AND NEW.status IN ('SUCCEEDED', 'FAILED'))) THEN
    RAISE EXCEPTION 'KLINIVA_INVALID_TRANSITION: AI action log % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.confirmed AND NOT NEW.confirmed THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: confirmation cannot be withdrawn' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_action_logs_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."ai_action_logs"
  FOR EACH ROW EXECUTE FUNCTION kliniva.ai_action_logs_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION kliniva.voice_sessions_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT kliniva.retention_purge_enabled() THEN
      RAISE EXCEPTION 'KLINIVA_IMMUTABLE: voice sessions are not deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'KLINIVA_INVALID: new voice session must be ACTIVE' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.transport IS DISTINCT FROM OLD.transport OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: voice session identity' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'ACTIVE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: voice session is final (%)', OLD.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER voice_sessions_guard BEFORE INSERT OR UPDATE OR DELETE ON "kliniva"."voice_sessions"
  FOR EACH ROW EXECUTE FUNCTION kliniva.voice_sessions_guard();
--> statement-breakpoint

-- ------------------------------------------------------------------ RLS (ENABLE + FORCE)
ALTER TABLE "kliniva"."voice_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."voice_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."voice_sessions"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."ai_action_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."ai_action_logs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."ai_action_logs"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint
ALTER TABLE "kliniva"."pending_ai_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kliniva"."pending_ai_actions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kliniva"."pending_ai_actions"
  USING (tenant_id = kliniva.current_tenant_id()) WITH CHECK (tenant_id = kliniva.current_tenant_id());
--> statement-breakpoint

-- ------------------------------------------------------------------ yetkiler (en az yetki, DELETE yok)
GRANT SELECT, INSERT ON "kliniva"."voice_sessions" TO kliniva_app;
--> statement-breakpoint
GRANT UPDATE (status, ended_at, client_session_id, language) ON "kliniva"."voice_sessions" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "kliniva"."ai_action_logs" TO kliniva_app;
--> statement-breakpoint
GRANT UPDATE (status, confirmed, entity_type, entity_id, safe_metadata, updated_at) ON "kliniva"."ai_action_logs" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "kliniva"."pending_ai_actions" TO kliniva_app;
--> statement-breakpoint
GRANT UPDATE (status, confirmed_at, executed_at, result_entity_id, result_code, ai_action_log_id, updated_at)
  ON "kliniva"."pending_ai_actions" TO kliniva_app;
