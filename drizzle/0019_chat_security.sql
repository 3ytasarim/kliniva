-- Sprint 7.2 — yazılı sohbet kanalı: oturum kanalı (VOICE / CHAT) değişmez (kimlik alanı gibi korunur).
-- Uygulama rolünün channel üzerinde UPDATE yetkisi zaten yok (0017 sütun yetkileri); tetikleyici sahip rolünü de korur.
-- Not: AI_CHAT enum değerleri 0018'de eklendi; bu dosya onları KULLANMAZ (aynı transaction kısıtı).
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
     OR NEW.transport IS DISTINCT FROM OLD.transport OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: voice session identity' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'ACTIVE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'KLINIVA_IMMUTABLE: voice session is final (%)', OLD.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
