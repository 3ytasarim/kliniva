/**
 * Salt okunur veritabanı inceleme yardımcıları (inspect, migrate ön/son kontrolü, rol kurulumu).
 * Hiçbir fonksiyon şema/veri DEĞİŞTİRMEZ. Bağlantı dizesi, host veya parola döndürmez/yazdırmaz.
 */
import { createHash } from "node:crypto";
import type { ClientBase } from "pg";

export const APP_ROLE = "kliniva_app";

export const EXPECTED_TABLES = [
  "audit_logs",
  "branch_closures",
  "branch_working_hours",
  "branches",
  "clinic_profiles",
  "consent_choices",
  "consent_revocations",
  "doctor_branches",
  "doctor_profiles",
  "doctor_room_assignments",
  "doctor_schedule_exceptions",
  "doctor_working_hours",
  "document_templates",
  "patient_branches",
  "patient_documents",
  "patients",
  "permissions",
  "rate_limits",
  "role_permissions",
  "roles",
  "rooms",
  "sessions",
  "tenants",
  "user_roles",
  "users",
  "appointment_events",
  "appointments",
  "clinical_services",
  "doctor_services",
  "inventory_categories",
  "inventory_items",
  "inventory_locations",
  "patient_material_usage_items",
  "patient_material_usages",
  "service_material_templates",
  "stock_balances",
  "stock_lots",
  "stock_movements",
  "patient_material_usage_allocations",
  "notifications",
  "notification_preferences",
  "outbox_events",
  "voice_sessions",
  "ai_action_logs",
  "pending_ai_actions",
  "clinical_notes",
  "patient_charges",
  "cash_categories",
  "cash_transactions",
  "patient_lookups",
  "clinical_attachments",
  "patient_tasks",
  "lab_panels",
  "lab_results",
  "platform_admins",
  "platform_sessions",
  "platform_audit_logs",
] as const;

/** RLS (ENABLE + FORCE) zorunlu tablolar: kiracı tabloları + platform/kiracı karışık tablolar. */
export const RLS_TABLES = [
  "audit_logs",
  "branch_closures",
  "branch_working_hours",
  "branches",
  "clinic_profiles",
  "consent_choices",
  "consent_revocations",
  "doctor_branches",
  "doctor_profiles",
  "doctor_room_assignments",
  "doctor_schedule_exceptions",
  "doctor_working_hours",
  "document_templates",
  "patient_branches",
  "patient_documents",
  "patients",
  "roles",
  "rooms",
  "user_roles",
  "users",
  "appointment_events",
  "appointments",
  "clinical_services",
  "doctor_services",
  "inventory_categories",
  "inventory_items",
  "inventory_locations",
  "patient_material_usage_items",
  "patient_material_usages",
  "service_material_templates",
  "stock_balances",
  "stock_lots",
  "stock_movements",
  "patient_material_usage_allocations",
  "notifications",
  "notification_preferences",
  "outbox_events",
  "voice_sessions",
  "ai_action_logs",
  "pending_ai_actions",
  "clinical_notes",
  "patient_charges",
  "cash_categories",
  "cash_transactions",
  "patient_lookups",
  "clinical_attachments",
  "patient_tasks",
  "lab_panels",
  "lab_results",
] as const;

/** Uygulama rolünün tablo bazında OLMASI GEREKEN yetkiler (fazlası da eksiği de hata). */
export const APP_PRIVILEGES: Record<string, string[]> = {
  audit_logs: ["INSERT", "SELECT"],
  branches: ["INSERT", "SELECT", "UPDATE"],
  consent_choices: ["INSERT", "SELECT"],
  document_templates: ["INSERT", "SELECT", "UPDATE"],
  patient_documents: ["INSERT", "SELECT", "UPDATE"],
  patients: ["INSERT", "SELECT", "UPDATE"],
  permissions: ["SELECT"],
  rate_limits: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  role_permissions: ["SELECT"],
  roles: ["SELECT"],
  rooms: ["INSERT", "SELECT", "UPDATE"],
  sessions: ["INSERT", "SELECT", "UPDATE"],
  tenants: ["SELECT"], // + sütun düzeyinde UPDATE (patient_seq, updated_at)
  user_roles: ["DELETE", "INSERT", "SELECT"],
  users: ["INSERT", "SELECT", "UPDATE"],
  __drizzle_migrations: [],
  // Sprint 1
  clinic_profiles: ["INSERT", "SELECT", "UPDATE"],
  doctor_profiles: ["INSERT", "SELECT", "UPDATE"],
  branch_working_hours: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  doctor_branches: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  doctor_working_hours: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  doctor_room_assignments: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  doctor_schedule_exceptions: ["DELETE", "INSERT", "SELECT"],
  branch_closures: ["DELETE", "INSERT", "SELECT"],
  // Sprint 2
  patient_branches: ["INSERT", "SELECT", "UPDATE"],
  consent_revocations: ["INSERT", "SELECT"],
  // Sprint 3
  clinical_services: ["INSERT", "SELECT", "UPDATE"],
  doctor_services: ["INSERT", "SELECT", "UPDATE"],
  appointments: ["INSERT", "SELECT", "UPDATE"],
  appointment_events: ["INSERT", "SELECT"],
  // Sprint 4 — bakiye yalnızca okunur (defter tetikleyicisi yazar); defter yalnızca eklenir
  inventory_categories: ["INSERT", "SELECT", "UPDATE"],
  inventory_items: ["INSERT", "SELECT", "UPDATE"],
  inventory_locations: ["INSERT", "SELECT", "UPDATE"],
  // Sprint 5: lot satırında tablo düzeyi UPDATE yok — yalnızca meta veri / geri çağırma sütunları (aşağıda)
  stock_lots: ["INSERT", "SELECT"],
  patient_material_usages: ["INSERT", "SELECT", "UPDATE"],
  stock_balances: ["SELECT"],
  stock_movements: ["INSERT", "SELECT"],
  patient_material_usage_items: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  service_material_templates: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  patient_material_usage_allocations: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  // Sprint 6: tablo düzeyi UPDATE yok — yalnızca durum / zaman sütunları (aşağıda); DELETE yok
  notifications: ["INSERT", "SELECT"],
  notification_preferences: ["INSERT", "SELECT"],
  outbox_events: ["INSERT", "SELECT"],
  // Sprint 7: yalnızca durum sütunları güncellenebilir; DELETE yok
  voice_sessions: ["INSERT", "SELECT"],
  ai_action_logs: ["INSERT", "SELECT"],
  pending_ai_actions: ["INSERT", "SELECT"],
  // Sprint 7.3: muayene kaydı yalnızca ekleme (sürüm); UPDATE / DELETE yok
  clinical_notes: ["INSERT", "SELECT"],
  // Sprint 8: finans defterleri — UPDATE yalnızca iptal (tetikleyici), DELETE yok
  patient_charges: ["INSERT", "SELECT", "UPDATE"],
  cash_transactions: ["INSERT", "SELECT", "UPDATE"],
  cash_categories: ["INSERT", "SELECT", "UPDATE"],
  // Sprint 8.1: hasta tanımları (silme yok; pasifleştirilir)
  patient_lookups: ["INSERT", "SELECT", "UPDATE"],
  // Sprint 8.2: muayene dosyaları — UPDATE yalnızca geçersiz kılma (tetikleyici), DELETE yok
  clinical_attachments: ["INSERT", "SELECT", "UPDATE"],
  // Sprint 8.3: hasta görevleri (silinmez, iptal edilir)
  patient_tasks: ["INSERT", "SELECT", "UPDATE"],
  // Sprint 8.4: tahliller (sonuç yalnızca geçersiz kılınır; tip pasifleştirilir)
  lab_panels: ["INSERT", "SELECT", "UPDATE"],
  lab_results: ["INSERT", "SELECT", "UPDATE"],
  // Sprint 9: platform tabloları (kiracı dışı; RLS yok). Denetim kaydı yalnızca ekleme.
  platform_admins: ["SELECT", "UPDATE"],
  platform_sessions: ["INSERT", "SELECT", "UPDATE"],
  platform_audit_logs: ["INSERT", "SELECT"],
};

export function isPoolerUrl(url: string | undefined): boolean | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.includes("-pooler");
  } catch {
    return null;
  }
}

export function urlUser(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).username) || null;
  } catch {
    return null;
  }
}

export type RoleInfo = {
  database: string;
  currentUser: string;
  serverVersion: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
};

export async function roleInfo(c: ClientBase): Promise<RoleInfo> {
  const r = await c.query(`
    select current_database() as database, current_user as "currentUser",
           current_setting('server_version') as "serverVersion",
           rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      from pg_roles where rolname = current_user`);
  return r.rows[0] as RoleInfo;
}

export type KlinivaState = {
  schemaExists: boolean;
  schemaOwner: string | null;
  tables: string[];
  otherObjects: number;
  migrationsApplied: number | null;
  rls: { table: string; enabled: boolean; forced: boolean; owner: string }[];
  appRoleExists: boolean;
};

export async function klinivaState(c: ClientBase): Promise<KlinivaState> {
  const schema = await c.query(
    `select n.nspname, pg_get_userbyid(n.nspowner) as owner from pg_namespace n where n.nspname = 'kliniva'`,
  );
  const tables = await c.query(`
    select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
           pg_get_userbyid(c.relowner) as owner
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'kliniva' and c.relkind = 'r' order by c.relname`);
  const other = await c.query(`
    select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'kliniva' and c.relkind not in ('r', 'i', 'S')`);
  let migrationsApplied: number | null = null;
  const mt = await c.query(`select to_regclass('kliniva.__drizzle_migrations') is not null as e`);
  if (mt.rows[0]?.e) {
    const m = await c.query(`select count(*)::int as n from kliniva.__drizzle_migrations`);
    migrationsApplied = m.rows[0]?.n ?? 0;
  }
  const role = await c.query(`select 1 from pg_roles where rolname = $1`, [APP_ROLE]);
  return {
    schemaExists: (schema.rowCount ?? 0) > 0,
    schemaOwner: schema.rows[0]?.owner ?? null,
    tables: tables.rows.map((t) => t.table as string).filter((t) => t !== "__drizzle_migrations"),
    otherObjects: other.rows[0]?.n ?? 0,
    migrationsApplied,
    rls: tables.rows
      .filter((t) => t.table !== "__drizzle_migrations")
      .map((t) => ({ table: t.table, enabled: t.enabled, forced: t.forced, owner: t.owner })),
    appRoleExists: (role.rowCount ?? 0) > 0,
  };
}

/** kliniva DIŞINDAKİ tüm kullanıcı şemalarının yapısal parmak izi (tablo + sütun + tip + kısıt + indeks). */
export async function foreignSchemasFingerprint(
  c: ClientBase,
): Promise<{ schemas: Record<string, { tables: number; hash: string }>; hash: string }> {
  const r = await c.query(`
    select n.nspname as schema, c.relname as rel, c.relkind as kind,
           coalesce((select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, ',' order by a.attnum)
                       from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '') as cols,
           coalesce((select string_agg(pg_get_constraintdef(k.oid), ';' order by k.conname)
                       from pg_constraint k where k.conrelid = c.oid), '') as cons,
           c.relrowsecurity::text || c.relforcerowsecurity::text as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname not in ('kliniva', 'information_schema', 'pg_catalog', 'pg_toast')
       and n.nspname not like 'pg\\_temp%' and n.nspname not like 'pg\\_toast\\_temp%'
       and c.relkind in ('r', 'v', 'm', 'i', 'S', 'p', 'f')
     order by 1, 2`);
  const schemas: Record<string, { tables: number; lines: string[] }> = {};
  for (const row of r.rows) {
    const s = (schemas[row.schema] ??= { tables: 0, lines: [] });
    if (row.kind === "r" || row.kind === "p") s.tables++;
    s.lines.push(`${row.rel}|${row.kind}|${row.cols}|${row.cons}|${row.rls}`);
  }
  const out: Record<string, { tables: number; hash: string }> = {};
  for (const [name, s] of Object.entries(schemas)) {
    out[name] = {
      tables: s.tables,
      hash: createHash("sha256").update(s.lines.join("\n")).digest("hex").slice(0, 16),
    };
  }
  const hash = createHash("sha256").update(JSON.stringify(out)).digest("hex").slice(0, 16);
  return { schemas: out, hash };
}

export type AppRoleCheck = {
  exists: boolean;
  canLogin: boolean;
  unsafeAttributes: string[];
  ownsKlinivaObjects: number;
  createOnPublic: boolean;
  createOnKliniva: boolean;
  privilegeMismatches: string[];
};

/** Uygulama rolünün güvenli olduğunu doğrular (rol yönetici bağlantısından incelenir). */
export async function checkAppRole(c: ClientBase, role = APP_ROLE): Promise<AppRoleCheck> {
  const r = await c.query(
    `select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
       from pg_roles where rolname = $1`,
    [role],
  );
  if (!r.rowCount) {
    return {
      exists: false,
      canLogin: false,
      unsafeAttributes: [],
      ownsKlinivaObjects: 0,
      createOnPublic: false,
      createOnKliniva: false,
      privilegeMismatches: [],
    };
  }
  const a = r.rows[0];
  const unsafe = ["rolsuper", "rolbypassrls", "rolcreatedb", "rolcreaterole", "rolreplication"].filter(
    (k) => a[k],
  );
  const owns = await c.query(
    `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'kliniva' and pg_get_userbyid(c.relowner) = $1`,
    [role],
  );
  const create = await c.query(
    `select has_schema_privilege($1, 'public', 'CREATE') as pub,
            coalesce(has_schema_privilege($1, 'kliniva', 'CREATE'), false) as kli`,
    [role],
  );
  const mismatches: string[] = [];
  for (const [table, expected] of Object.entries(APP_PRIVILEGES)) {
    const exists = await c.query(`select to_regclass($1) is not null as e`, [`kliniva.${table}`]);
    if (!exists.rows[0]?.e) continue;
    const actual: string[] = [];
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      const p = await c.query(`select has_table_privilege($1, $2, $3) as ok`, [
        role,
        `kliniva.${table}`,
        priv,
      ]);
      if (p.rows[0]?.ok) actual.push(priv);
    }
    const exp = [...expected].sort().join(",");
    const act = actual.sort().join(",");
    if (exp !== act) mismatches.push(`${table}: beklenen [${exp}] mevcut [${act}]`);
  }
  const seqUpd = await c
    .query(
      `select has_column_privilege($1, 'kliniva.tenants', 'patient_seq', 'UPDATE') as seq,
            has_column_privilege($1, 'kliniva.tenants', 'name', 'UPDATE') as name`,
      [role],
    )
    .catch(() => ({ rows: [{ seq: false, name: false }] }));
  if (!seqUpd.rows[0]?.seq) mismatches.push("tenants.patient_seq: UPDATE yok");
  // Lot bakiyesi yalnızca defter tetikleyicisiyle değişir: miktar / numara sütunlarına UPDATE OLMAMALI.
  const lotCols = await c
    .query(
      `select to_regclass('kliniva.stock_lots') is not null as e,
              has_column_privilege($1, 'kliniva.stock_lots', 'quantity', 'UPDATE') as qty,
              has_column_privilege($1, 'kliniva.stock_lots', 'lot_number', 'UPDATE') as num,
              has_column_privilege($1, 'kliniva.stock_lots', 'recalled_at', 'UPDATE') as rec`,
      [role],
    )
    .catch(() => ({ rows: [{ e: false, qty: false, num: false, rec: true }] }));
  const lc = lotCols.rows[0];
  if (lc?.e) {
    if (lc.qty) mismatches.push("stock_lots.quantity: gereksiz UPDATE");
    if (lc.num) mismatches.push("stock_lots.lot_number: gereksiz UPDATE");
    if (!lc.rec) mismatches.push("stock_lots.recalled_at: UPDATE yok");
  }
  if (seqUpd.rows[0]?.name) mismatches.push("tenants.name: gereksiz UPDATE");
  // Bildirim içeriği / outbox yükü uygulama rolünce değiştirilemez: yalnızca durum sütunları güncellenebilir.
  const s6 = await c
    .query(
      `select to_regclass('kliniva.notifications') is not null as e,
              has_column_privilege($1, 'kliniva.notifications', 'status', 'UPDATE') as n_status,
              has_column_privilege($1, 'kliniva.notifications', 'title', 'UPDATE') as n_title,
              has_column_privilege($1, 'kliniva.notifications', 'recipient_user_id', 'UPDATE') as n_recipient,
              has_column_privilege($1, 'kliniva.outbox_events', 'status', 'UPDATE') as o_status,
              has_column_privilege($1, 'kliniva.outbox_events', 'payload_safe', 'UPDATE') as o_payload`,
      [role],
    )
    .catch(() => ({ rows: [{ e: false }] as Record<string, boolean>[] }));
  const n6 = s6.rows[0];
  if (n6?.e) {
    if (!n6.n_status) mismatches.push("notifications.status: UPDATE yok");
    if (n6.n_title) mismatches.push("notifications.title: gereksiz UPDATE");
    if (n6.n_recipient) mismatches.push("notifications.recipient_user_id: gereksiz UPDATE");
    if (!n6.o_status) mismatches.push("outbox_events.status: UPDATE yok");
    if (n6.o_payload) mismatches.push("outbox_events.payload_safe: gereksiz UPDATE");
  }
  // AI eylemi: girdi / özet / oturum sütunları uygulama rolünce değiştirilemez.
  const s7 = await c
    .query(
      `select to_regclass('kliniva.pending_ai_actions') is not null as e,
              has_column_privilege($1, 'kliniva.pending_ai_actions', 'input_encrypted', 'UPDATE') as p_input,
              has_column_privilege($1, 'kliniva.pending_ai_actions', 'safe_input_hash', 'UPDATE') as p_hash,
              has_column_privilege($1, 'kliniva.pending_ai_actions', 'status', 'UPDATE') as p_status,
              has_column_privilege($1, 'kliniva.ai_action_logs', 'tool_name', 'UPDATE') as l_tool`,
      [role],
    )
    .catch(() => ({ rows: [{ e: false }] as Record<string, boolean>[] }));
  const n7 = s7.rows[0];
  if (n7?.e) {
    if (n7.p_input) mismatches.push("pending_ai_actions.input_encrypted: gereksiz UPDATE");
    if (n7.p_hash) mismatches.push("pending_ai_actions.safe_input_hash: gereksiz UPDATE");
    if (!n7.p_status) mismatches.push("pending_ai_actions.status: UPDATE yok");
    if (n7.l_tool) mismatches.push("ai_action_logs.tool_name: gereksiz UPDATE");
  }
  // Sohbet kanalı (0018+): oturum kanalı uygulama rolünce değiştirilemez.
  const s8 = await c
    .query(`select has_column_privilege($1, 'kliniva.voice_sessions', 'channel', 'UPDATE') as v_channel`, [
      role,
    ])
    .catch(() => ({ rows: [] as Record<string, boolean>[] }));
  if (s8.rows[0]?.v_channel) mismatches.push("voice_sessions.channel: gereksiz UPDATE");
  return {
    exists: true,
    canLogin: a.rolcanlogin,
    unsafeAttributes: unsafe,
    ownsKlinivaObjects: owns.rows[0]?.n ?? 0,
    createOnPublic: create.rows[0]?.pub ?? false,
    createOnKliniva: create.rows[0]?.kli ?? false,
    privilegeMismatches: mismatches,
  };
}

/** Hata nesnesinden yalnızca güvenli kod/sınıf (bağlantı ayrıntısı sızmasın). */
export function safeError(e: unknown): string {
  const code = (e as { code?: string }).code;
  // SQLSTATE (5 karakter) → sunucu mesajı güvenlidir (bağlantı dizesi içermez). Ağ hatalarında (ENOTFOUND vb.)
  // mesaj host adı içerebileceği için yalnızca kod yazılır.
  if (code && /^[0-9A-Z]{5}$/.test(code)) return `PG ${code}: ${(e as Error).message}`;
  if (code) return `bağlantı hatası (${code})`;
  if (e instanceof Error && /^(MIGRATION_)?DATABASE_URL is required$/.test(e.message)) return e.message;
  if (e instanceof Error && /^KLINIVA_|^STOP:/.test(e.message)) return e.message;
  // Diğer mesajlar yalnızca URL/kimlik bilgisi izi taşımıyorsa yazılır.
  if (e instanceof Error && !/:\/\/|@|password|parola=/i.test(e.message)) return e.message;
  return e instanceof Error ? e.name : "hata";
}
