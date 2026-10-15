import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getPool } from "@/server/db/client";
import { getMigrationDb } from "@/server/db/migration-client";
import { branches, roles, tenants, userRoles, users } from "@/server/db/schema";
import { syncRbacCatalog } from "@/server/auth/rbac-sync";
import { authenticate } from "@/server/auth/context";
import { login } from "@/server/auth/login";
import { runInTenantWith } from "@/server/tenant/tenant-query";
import { hashPassword } from "@/server/security/password";
import { MemoryEncryptedStorage, setPrivateStorageForTests } from "@/server/storage/private-storage";
import type { AuthContext } from "@/server/auth/authz";
import type { RoleKey } from "@/server/auth/permissions";
import type { RequestMeta } from "@/server/security/request-meta";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Entegrasyon testi fikstürleri — MEVCUT veritabanında rastgele slug'lı test kiracıları oluşturur ve siler.
 * Silme, yasal imha yolunun aynısıyla (kliniva.retention_purge = 'on') yapılır.
 *
 * ROL AYRIMI (kritik):
 *   - KURULUM ve TEMİZLİK → migration bağlantısı (şema sahibi): kiracı/RBAC oluşturma ve imha uygulama rolüne kapalıdır.
 *   - TEST EDİLEN HER ŞEY (servisler, route handler'lar, ham RLS sorguları) → getPool()/getDb() = DATABASE_URL =
 *     kliniva_app. prepareDatabase() bunu doğrular; aksi halde testler hiç çalışmaz (RLS yanlışlıkla atlanmasın).
 */
export const TEST_PASSWORD = `Test-${randomBytes(9).toString("base64url")}-7`;
export const storage = new MemoryEncryptedStorage();

const createdTenants: string[] = [];
let prepared = false;

export function freshMeta(): RequestMeta {
  return { ipHash: `test-${randomUUID()}`, userAgentSummary: "Vitest/Node" };
}

export const APP_ROLE = "kliniva_app";

export async function prepareDatabase() {
  if (prepared) return;
  const migrationFiles = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).length;
  const admin = getMigrationDb();
  const res = await admin.execute<{ n: number }>(
    sql`select case when to_regclass('kliniva.__drizzle_migrations') is null then 0 else (select count(*) from kliniva.__drizzle_migrations) end::int as n`,
  );
  const applied = Number(res.rows[0]?.n ?? 0);
  if (applied < migrationFiles) {
    throw new Error(`Migration'lar uygulanmamış (${applied}/${migrationFiles}). Önce: npm run db:migrate`);
  }
  // Uygulama bağlantısı GERÇEKTEN en az yetkili rol mü? Değilse RLS testleri anlamsızdır → dur.
  const who = await getPool().query<{ u: string; su: boolean; by: boolean; owns: number }>(`
    select current_user as u, r.rolsuper as su, r.rolbypassrls as by,
           (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'kliniva' and c.relowner = r.oid) as owns
      from pg_roles r where r.rolname = current_user`);
  const w = who.rows[0];
  if (!w || w.u !== APP_ROLE || w.su || w.by || w.owns > 0) {
    throw new Error(
      `STOP: testler '${APP_ROLE}' dışındaki/güvensiz bir runtime rolüyle çalışmaz (DATABASE_URL kontrol edin)`,
    );
  }
  await syncRbacCatalog(admin);
  setPrivateStorageForTests(storage);
  prepared = true;
}

export type TestUser = { id: string; email: string; ctx: AuthContext; token: string };
export type TestTenant = {
  id: string;
  slug: string;
  branchA: string;
  branchB: string;
  users: Record<string, TestUser>;
};

/**
 * Kiracı + iki şube + istenen kullanıcılar. Kullanıcılar gerçek login() ile oturum açar → AuthContext
 * gerçek authenticate() ile üretilir (testler üretim akışını kullanır).
 */
export async function createTenant(
  spec: Record<string, { role: RoleKey; branch?: "A" | "B" | null; active?: boolean }>,
): Promise<TestTenant> {
  await prepareDatabase();
  const slug = `t-test-${randomBytes(5).toString("hex")}`;
  const admin = getMigrationDb();
  const [tenant] = await admin
    .insert(tenants)
    .values({ name: `Test Klinik ${slug}`, slug })
    .returning();
  createdTenants.push(tenant!.id);

  const systemRoles = await runInTenantWith(admin, tenant!.id, (scope) =>
    scope.tx.select({ id: roles.id, key: roles.key }).from(roles).where(isNull(roles.tenantId)),
  );
  const roleId = new Map(systemRoles.map((r) => [r.key, r.id]));
  const passwordHash = await hashPassword(TEST_PASSWORD);

  const ids = await runInTenantWith(admin, tenant!.id, async (scope) => {
    const [a] = await scope.tx
      .insert(branches)
      .values({ tenantId: scope.tenantId, name: "Şube A", city: "İstanbul" })
      .returning({ id: branches.id });
    const [b] = await scope.tx
      .insert(branches)
      .values({ tenantId: scope.tenantId, name: "Şube B", city: "Ankara" })
      .returning({ id: branches.id });
    const created: Record<string, { id: string; email: string; active: boolean }> = {};
    for (const [name, s] of Object.entries(spec)) {
      const email = `${name.toLowerCase()}@${slug}.test`;
      const [u] = await scope.tx
        .insert(users)
        .values({
          tenantId: scope.tenantId,
          email,
          emailNormalized: email,
          passwordHash,
          firstName: name,
          lastName: "Test",
        })
        .returning({ id: users.id });
      const branchId = s.branch === "A" ? a!.id : s.branch === "B" ? b!.id : null;
      await scope.tx
        .insert(userRoles)
        .values({ tenantId: scope.tenantId, userId: u!.id, roleId: roleId.get(s.role)!, branchId });
      created[name] = { id: u!.id, email, active: s.active ?? true };
    }
    return { a: a!.id, b: b!.id, created };
  });

  const result: TestTenant = { id: tenant!.id, slug, branchA: ids.a, branchB: ids.b, users: {} };
  for (const [name, u] of Object.entries(ids.created)) {
    const res = await login({ tenantSlug: slug, email: u.email, password: TEST_PASSWORD }, freshMeta());
    if (!res.ok) throw new Error(`fixture login failed for ${name}: ${res.code}`);
    const ctx = await authenticate(res.token, freshMeta());
    if (!ctx) throw new Error(`fixture authenticate failed for ${name}`);
    result.users[name] = { id: u.id, email: u.email, ctx, token: res.token };
  }
  // Pasif olarak istenen kullanıcılar oturum açtıktan SONRA pasifleştirilir.
  for (const [name, u] of Object.entries(ids.created)) {
    if (!u.active) {
      await runInTenantWith(admin, tenant!.id, (scope) =>
        scope.tx
          .update(users)
          .set({ active: false })
          .where(and(eq(users.tenantId, scope.tenantId), eq(users.id, u.id))),
      );
      void name;
    }
  }
  return result;
}

/** Test kiracılarını yasal imha bağlamında siler (imzalı belge / audit tetikleyicileri bu bağlamda izin verir). */
export async function cleanupTenants() {
  if (!createdTenants.length) return;
  const ids = createdTenants.splice(0);
  await getMigrationDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('kliniva.retention_purge', 'on', true)`);
    for (const id of ids) {
      await tx.execute(sql`select set_config('app.tenant_id', ${id}, true)`);
      await tx.execute(sql`delete from kliniva.notifications where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.notification_preferences where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.outbox_events where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.pending_ai_actions where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.ai_action_logs where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.voice_sessions where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.patient_material_usage_allocations where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.patient_material_usage_items where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.stock_movements where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.stock_balances where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.stock_lots where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.service_material_templates where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.patient_material_usages where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.inventory_locations where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.inventory_items where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.inventory_categories where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.appointment_events where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.appointments where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.consent_revocations where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.consent_choices where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.patient_documents where tenant_id = ${id}`);
      await tx.execute(sql`delete from kliniva.tenants where id = ${id}`);
    }
  });
}

/** API route handler'larını gerçek Request ile çağırmak için. */
export function apiRequest(
  path: string,
  opts: { method?: string; token?: string | null; body?: unknown; origin?: string } = {},
): Request {
  const headers: Record<string, string> = { host: "localhost:3000" };
  if (opts.token) headers.cookie = `kliniva_session=${encodeURIComponent(opts.token)}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.method && opts.method !== "GET") headers.origin = opts.origin ?? "http://localhost:3000";
  return new Request(`http://localhost:3000${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

export const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Drizzle hataları pg hatasını `cause` içinde taşır; mesaj/kodu oradan (yoksa kendisinden) okur. */
export async function dbError(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = ((e as { cause?: unknown }).cause ?? e) as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
  throw new Error("expected database error, got success");
}
