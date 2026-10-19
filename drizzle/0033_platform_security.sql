-- Sprint 9 — platform yönetimi güvenliği.
--  * Platform tabloları (platform_admins / platform_sessions / platform_audit_logs) kiracıya bağlı DEĞİLDİR → RLS yok;
--    uygulama rolüne yalnızca gereken yetkiler verilir (denetim kaydı: yalnızca ekleme).
--  * Kiracı oluşturma / listeleme / askıya alma / sahip parolası sıfırlama YALNIZCA aşağıdaki SECURITY DEFINER
--    fonksiyonlarla yapılır. Her fonksiyon önce geçerli, iki adımlı doğrulaması tamamlanmış (ACTIVE) bir platform
--    oturumunun token özetini doğrular; aksi halde KLINIVA_FORBIDDEN. Uygulama rolü kiracı tablolarına çapraz
--    erişim kazanmaz; hasta / randevu içeriği hiçbir fonksiyondan dönmez (yalnızca sayılar).
--  * search_path sabitlenir; PUBLIC'ten EXECUTE geri alınır, yalnızca kliniva_app'e verilir.
CREATE OR REPLACE FUNCTION kliniva.platform_session_admin(p_token_hash text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = kliniva, pg_temp
AS $$
  SELECT a.id
    FROM kliniva.platform_sessions s
    JOIN kliniva.platform_admins a ON a.id = s.admin_id
   WHERE s.token_hash = p_token_hash
     AND s.state = 'ACTIVE'
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND a.active
     AND a.two_factor_enabled
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kliniva.platform_session_admin(text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kliniva.platform_require_admin(p_token_hash text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = kliniva, pg_temp
AS $$
DECLARE
  v_admin uuid;
BEGIN
  v_admin := kliniva.platform_session_admin(p_token_hash);
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'KLINIVA_FORBIDDEN: platform session required' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_admin;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kliniva.platform_require_admin(text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kliniva.platform_list_tenants(p_token_hash text)
RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  status text,
  created_at timestamptz,
  users_total int,
  users_active int,
  branches_total int,
  patients_total int,
  appointments_30d int,
  last_login_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = kliniva, pg_temp
AS $$
BEGIN
  PERFORM kliniva.platform_require_admin(p_token_hash);
  RETURN QUERY
  SELECT t.id, t.name, t.slug, t.status::text, t.created_at,
         (SELECT count(*)::int FROM kliniva.users u WHERE u.tenant_id = t.id),
         (SELECT count(*)::int FROM kliniva.users u WHERE u.tenant_id = t.id AND u.active),
         (SELECT count(*)::int FROM kliniva.branches b WHERE b.tenant_id = t.id),
         (SELECT count(*)::int FROM kliniva.patients p WHERE p.tenant_id = t.id),
         (SELECT count(*)::int FROM kliniva.appointments ap
           WHERE ap.tenant_id = t.id AND ap.scheduled_start >= now() - interval '30 days'),
         (SELECT max(u.last_login_at) FROM kliniva.users u WHERE u.tenant_id = t.id)
    FROM kliniva.tenants t
   ORDER BY t.created_at DESC;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kliniva.platform_tenant_owners(p_token_hash text, p_tenant_id uuid)
RETURNS TABLE (
  user_id uuid,
  first_name text,
  last_name text,
  email text,
  username text,
  active boolean,
  must_change_password boolean,
  last_login_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = kliniva, pg_temp
AS $$
BEGIN
  PERFORM kliniva.platform_require_admin(p_token_hash);
  RETURN QUERY
  SELECT DISTINCT u.id, u.first_name, u.last_name, u.email, u.username, u.active, u.must_change_password,
         u.last_login_at
    FROM kliniva.users u
    JOIN kliniva.user_roles ur ON ur.tenant_id = u.tenant_id AND ur.user_id = u.id
    JOIN kliniva.roles r ON r.id = ur.role_id AND r.key = 'CLINIC_OWNER'
   WHERE u.tenant_id = p_tenant_id
   ORDER BY u.first_name;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kliniva.platform_create_tenant(
  p_token_hash text,
  p_name text,
  p_slug text,
  p_city text,
  p_owner_first text,
  p_owner_last text,
  p_owner_email text,
  p_owner_email_norm text,
  p_owner_username text,
  p_owner_username_norm text,
  p_password_hash text,
  p_ip_hash text
)
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = kliniva, pg_temp
AS $$
DECLARE
  v_admin uuid;
  v_tenant uuid;
  v_user uuid;
  v_role uuid;
BEGIN
  v_admin := kliniva.platform_require_admin(p_token_hash);
  IF p_password_hash IS NULL OR p_password_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: password must be an argon2id hash' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_role FROM kliniva.roles WHERE key = 'CLINIC_OWNER' AND tenant_id IS NULL;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: CLINIC_OWNER role missing (run seed)' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO kliniva.tenants (name, slug) VALUES (p_name, p_slug) RETURNING id INTO v_tenant;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  INSERT INTO kliniva.branches (tenant_id, name, city) VALUES (v_tenant, 'Merkez', p_city);
  INSERT INTO kliniva.clinic_profiles (tenant_id, display_name) VALUES (v_tenant, p_name);
  INSERT INTO kliniva.users (tenant_id, email, email_normalized, username, username_normalized, password_hash,
                             first_name, last_name, must_change_password)
       VALUES (v_tenant, p_owner_email, p_owner_email_norm, p_owner_username, p_owner_username_norm,
               p_password_hash, p_owner_first, p_owner_last, true)
    RETURNING id INTO v_user;
  INSERT INTO kliniva.user_roles (tenant_id, user_id, role_id, branch_id) VALUES (v_tenant, v_user, v_role, NULL);
  -- Varsayılan tanımlar (klinik sonradan değiştirebilir)
  INSERT INTO kliniva.patient_lookups (tenant_id, kind, name)
       SELECT v_tenant, 'SOURCE', x FROM unnest(ARRAY['Google', 'Instagram', 'Tavsiye / Referans', 'Web sitesi', 'Diğer']) AS x;
  INSERT INTO kliniva.cash_categories (tenant_id, name, kind)
       SELECT v_tenant, x, 'EXPENSE' FROM unnest(ARRAY['Kira', 'Personel', 'Faturalar', 'Malzeme ve sarf', 'Reklam ve pazarlama']) AS x;
  INSERT INTO kliniva.cash_categories (tenant_id, name, kind) VALUES (v_tenant, 'Diğer gelir', 'INCOME');
  INSERT INTO kliniva.platform_audit_logs (admin_id, action, target_tenant_id, metadata_safe, ip_hash)
       VALUES (v_admin, 'TENANT_CREATED', v_tenant, '{}'::jsonb, p_ip_hash);
  RETURN QUERY SELECT v_tenant, v_user;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kliniva.platform_set_tenant_status(
  p_token_hash text,
  p_tenant_id uuid,
  p_status text,
  p_ip_hash text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = kliniva, pg_temp
AS $$
DECLARE
  v_admin uuid;
BEGIN
  v_admin := kliniva.platform_require_admin(p_token_hash);
  IF p_status NOT IN ('ACTIVE', 'SUSPENDED') THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: status' USING ERRCODE = 'P0001';
  END IF;
  UPDATE kliniva.tenants SET status = p_status::kliniva.tenant_status, updated_at = now() WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KLINIVA_NOT_FOUND: tenant' USING ERRCODE = 'P0001';
  END IF;
  IF p_status = 'SUSPENDED' THEN
    UPDATE kliniva.sessions SET revoked_at = now() WHERE tenant_id = p_tenant_id AND revoked_at IS NULL;
  END IF;
  INSERT INTO kliniva.platform_audit_logs (admin_id, action, target_tenant_id, metadata_safe, ip_hash)
       VALUES (v_admin, CASE WHEN p_status = 'SUSPENDED' THEN 'TENANT_SUSPENDED' ELSE 'TENANT_ACTIVATED' END,
               p_tenant_id, '{}'::jsonb, p_ip_hash);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kliniva.platform_reset_owner_password(
  p_token_hash text,
  p_tenant_id uuid,
  p_user_id uuid,
  p_password_hash text,
  p_ip_hash text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = kliniva, pg_temp
AS $$
DECLARE
  v_admin uuid;
BEGIN
  v_admin := kliniva.platform_require_admin(p_token_hash);
  IF p_password_hash IS NULL OR p_password_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'KLINIVA_INVALID: password must be an argon2id hash' USING ERRCODE = 'P0001';
  END IF;
  -- Yalnızca klinik SAHİBİ hesabı (platform, klinik personelinin hesabına dokunmaz).
  IF NOT EXISTS (
    SELECT 1 FROM kliniva.user_roles ur JOIN kliniva.roles r ON r.id = ur.role_id AND r.key = 'CLINIC_OWNER'
     WHERE ur.tenant_id = p_tenant_id AND ur.user_id = p_user_id) THEN
    RAISE EXCEPTION 'KLINIVA_NOT_FOUND: owner' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  UPDATE kliniva.users
     SET password_hash = p_password_hash, must_change_password = true, password_changed_at = now(),
         updated_at = now()
   WHERE tenant_id = p_tenant_id AND id = p_user_id;
  UPDATE kliniva.sessions SET revoked_at = now()
   WHERE tenant_id = p_tenant_id AND user_id = p_user_id AND revoked_at IS NULL;
  INSERT INTO kliniva.platform_audit_logs (admin_id, action, target_tenant_id, metadata_safe, ip_hash)
       VALUES (v_admin, 'OWNER_PASSWORD_RESET', p_tenant_id, '{}'::jsonb, p_ip_hash);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kliniva.platform_list_tenants(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kliniva.platform_tenant_owners(text, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kliniva.platform_create_tenant(text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kliniva.platform_set_tenant_status(text, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kliniva.platform_reset_owner_password(text, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kliniva.platform_list_tenants(text) TO kliniva_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kliniva.platform_tenant_owners(text, uuid) TO kliniva_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kliniva.platform_create_tenant(text, text, text, text, text, text, text, text, text, text, text, text) TO kliniva_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kliniva.platform_set_tenant_status(text, uuid, text, text) TO kliniva_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kliniva.platform_reset_owner_password(text, uuid, uuid, text, text) TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "kliniva"."platform_admins" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "kliniva"."platform_sessions" TO kliniva_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "kliniva"."platform_audit_logs" TO kliniva_app;
