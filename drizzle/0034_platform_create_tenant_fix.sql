-- 0033'teki platform_create_tenant: RETURNS TABLE (tenant_id ...) çıktı değişkeni, roles.tenant_id kolonuyla
-- PL/pgSQL'de çakışıyordu (42702). Sorgu tablo takma adıyla nitelendirildi; imza ve yetkiler aynı kalır.
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
  SELECT r.id INTO v_role FROM kliniva.roles r WHERE r.key = 'CLINIC_OWNER' AND r.tenant_id IS NULL;
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
