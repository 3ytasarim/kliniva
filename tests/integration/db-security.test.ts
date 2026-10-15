import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { getPool } from "@/server/db/client";
import { getMigrationDb } from "@/server/db/migration-client";
import { tenantQuery } from "@/server/tenant/tenant-query";
import { createPatient } from "@/server/services/patients";
import { APP_ROLE, cleanupTenants, createTenant, dbError, type TestTenant } from "../support/fixtures";

/**
 * Veritabanı seviyesinde güvenlik — TÜM sorgular uygulama rolüyle (kliniva_app, DATABASE_URL) çalışır.
 * Servis katmanı atlanır: RLS ve yetki matrisi tek başına izolasyonu sağlamalıdır.
 */
const RLS_TABLES = [
  "audit_logs",
  "branches",
  "consent_choices",
  "document_templates",
  "patient_documents",
  "patients",
  "roles",
  "rooms",
  "user_roles",
  "users",
  // Sprint 1
  "branch_closures",
  "branch_working_hours",
  "clinic_profiles",
  "doctor_branches",
  "doctor_profiles",
  "doctor_room_assignments",
  "doctor_schedule_exceptions",
  "doctor_working_hours",
  // Sprint 2
  "consent_revocations",
  "patient_branches",
];
const TENANT_TABLES = RLS_TABLES.filter((t) => t !== "roles" && t !== "document_templates");

let A: TestTenant;
let B: TestTenant;
let patientA: string;
let patientB: string;

async function inTx<T>(client: PoolClient, tenantId: string | null, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    if (tenantId) await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  A = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  patientA = (
    await createPatient(A.users.owner!.ctx, {
      firstName: "Ada",
      lastName: "A",
      phone: "05321000001",
      branchId: A.branchA,
    })
  ).id;
  patientB = (
    await createPatient(B.users.owner!.ctx, {
      firstName: "Bora",
      lastName: "B",
      phone: "05321000002",
      branchId: B.branchA,
    })
  ).id;
});

afterAll(cleanupTenants);

describe("Uygulama rolü (runtime) en az yetkili", () => {
  it("testler gerçekten kliniva_app ile çalışıyor; SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE değil", async () => {
    const r = await getPool().query(
      `select current_user as u, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
         from pg_roles where rolname = current_user`,
    );
    expect(r.rows[0]).toEqual({
      u: APP_ROLE,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    });
  });

  it("kliniva tablolarının sahibi değil; kliniva ve public şemalarında CREATE yok", async () => {
    const r = await getPool().query(`
      select (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'kliniva' and c.relowner = (select oid from pg_roles where rolname = current_user)) as owns,
             has_schema_privilege('kliniva', 'CREATE') as kli, has_schema_privilege('public', 'CREATE') as pub`);
    expect(r.rows[0]).toEqual({ owns: 0, kli: false, pub: false });
  });

  it(`tüm ${RLS_TABLES.length} kiracı tablosunda RLS ENABLE + FORCE`, async () => {
    const r = await getPool().query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
         join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'kliniva' and c.relname = any($1)`,
      [RLS_TABLES],
    );
    expect(r.rowCount).toBe(RLS_TABLES.length);
    for (const row of r.rows)
      expect([row.relname, row.relrowsecurity, row.relforcerowsecurity]).toEqual([row.relname, true, true]);
  });

  it("yetkisiz işlemler veritabanı tarafından reddedilir (42501)", async () => {
    const denied = [
      ["kiracı oluşturma", "insert into kliniva.tenants (name, slug) values ('x', 'x-denied')"],
      ["kiracı adını değiştirme", "update kliniva.tenants set name = 'x'"],
      ["kiracı silme", "delete from kliniva.tenants"],
      ["rol oluşturma", "insert into kliniva.roles (key, name) values ('X', 'X')"],
      ["yetki ekleme", "insert into kliniva.permissions (key, description) values ('x', 'x')"],
      ["audit silme", "delete from kliniva.audit_logs"],
      ["audit güncelleme", "update kliniva.audit_logs set action = 'X'"],
      ["imzalı belge silme", "delete from kliniva.patient_documents"],
      ["rıza seçimi güncelleme", "update kliniva.consent_choices set value = 'GRANTED'"],
      ["rıza seçimi silme", "delete from kliniva.consent_choices"],
      ["hasta silme", "delete from kliniva.patients"],
      ["hasta-şube bağı silme", "delete from kliniva.patient_branches"],
      ["rıza geri çekme kaydı güncelleme", "update kliniva.consent_revocations set reason = 'x'"],
      ["rıza geri çekme kaydı silme", "delete from kliniva.consent_revocations"],
      ["truncate", "truncate kliniva.patients"],
      ["migration geçmişi okuma", "select * from kliniva.__drizzle_migrations"],
      ["şemada tablo oluşturma", "create table kliniva.x_denied (id int)"],
      ["public şemada tablo oluşturma", "create table public.x_kliniva_denied (id int)"],
    ] as const;
    await withClient(async (c) => {
      for (const [name, stmt] of denied) {
        await inTx(c, A.id, async () => {
          await expect(c.query(stmt), name).rejects.toMatchObject({ code: "42501" });
        });
      }
    });
  });

  it("imha bayrağını kendisi açsa bile uygulama rolü imzalı belge / audit silemez", async () => {
    await withClient((c) =>
      inTx(c, A.id, async () => {
        await c.query("select set_config('kliniva.retention_purge', 'on', true)");
        await expect(c.query("delete from kliniva.patient_documents")).rejects.toMatchObject({
          code: "42501",
        });
      }),
    );
  });
});

describe("RLS — doğrudan veritabanı seviyesinde (servis katmanı yok)", () => {
  it("Tenant A bağlamı: A verisini okur, B verisini görmez", async () => {
    await withClient((c) =>
      inTx(c, A.id, async () => {
        const all = await c.query("select id, tenant_id from kliniva.patients");
        expect(all.rows.map((r) => r.id)).toContain(patientA);
        expect(all.rows.every((r) => r.tenant_id === A.id)).toBe(true);
        const branches = await c.query("select tenant_id from kliniva.branches");
        expect(branches.rows.every((r) => r.tenant_id === A.id)).toBe(true);
      }),
    );
  });

  it("B kaydını ID ile doğrudan istemek 0 satır döner", async () => {
    await withClient((c) =>
      inTx(c, A.id, async () => {
        expect((await c.query("select * from kliniva.patients where id = $1", [patientB])).rowCount).toBe(0);
        expect((await c.query("select * from kliniva.branches where id = $1", [B.branchA])).rowCount).toBe(0);
        expect((await c.query("select * from kliniva.users where tenant_id = $1", [B.id])).rowCount).toBe(0);
      }),
    );
  });

  it("B kaydını güncelleyemez (0 satır etkilenir) ve B verisi değişmez", async () => {
    await withClient(async (c) => {
      await c.query("begin");
      await c.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      const upd = await c.query("update kliniva.patients set first_name = 'Ele Geçirildi' where id = $1", [
        patientB,
      ]);
      expect(upd.rowCount).toBe(0);
      // tenant_id'yi değiştirerek kendi satırını B'ye taşıyamaz (WITH CHECK)
      await expect(
        c.query("update kliniva.patients set tenant_id = $1 where id = $2", [B.id, patientA]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("rollback");
    });
    const check = await getMigrationDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${B.id}, true)`);
      return tx.execute<{ first_name: string }>(
        sql`select first_name from kliniva.patients where id = ${patientB}`,
      );
    });
    expect(check.rows[0]?.first_name).toBe("Bora");
  });

  it("B adına insert yapamaz (RLS WITH CHECK → 42501)", async () => {
    await withClient(async (c) => {
      for (const [stmt, args] of [
        ["insert into kliniva.branches (tenant_id, name, city) values ($1, 'x', 'y')", [B.id]],
        [
          "insert into kliniva.patients (tenant_id, patient_number, first_name, last_name, phone) values ($1, 'P-X', 'x', 'y', '0')",
          [B.id],
        ],
        [
          "insert into kliniva.audit_logs (tenant_id, action, entity_type, source) values ($1, 'X', 'x', 'SYSTEM')",
          [B.id],
        ],
      ] as const) {
        await inTx(c, A.id, async () => {
          await expect(c.query(stmt, [...args])).rejects.toMatchObject({ code: "42501" });
        });
      }
    });
  });

  it("kiracı bağlamı YOK: hiçbir kiracı tablosunda satır görünmez, yazılamaz", async () => {
    await withClient((c) =>
      inTx(c, null, async () => {
        for (const t of TENANT_TABLES) {
          expect((await c.query(`select 1 from kliniva.${t} limit 1`)).rowCount, t).toBe(0);
        }
        await expect(
          c.query("insert into kliniva.branches (tenant_id, name, city) values ($1, 'x', 'y')", [A.id]),
        ).rejects.toMatchObject({ code: "42501" });
      }),
    );
    // Transaction dışı (autocommit) tek sorgu da aynı
    expect((await getPool().query("select 1 from kliniva.patients")).rowCount).toBe(0);
  });

  it("PLATFORM_SUPER_ADMIN, migration rolüyle bile kiracıya atanamaz (tetikleyici)", async () => {
    const err = await dbError(
      getMigrationDb().transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${A.id}, true)`);
        await tx.execute(sql`
          insert into kliniva.user_roles (tenant_id, user_id, role_id)
          select ${A.id}, ${A.users.owner!.id}, id from kliniva.roles where key = 'PLATFORM_SUPER_ADMIN' and tenant_id is null`);
      }),
    );
    expect(err.message).toMatch(/KLINIVA_FORBIDDEN: PLATFORM_SUPER_ADMIN/);
  });
});

describe("POOLED_CONNECTION_TENANT_CONTEXT_LEAK_TEST", () => {
  it("tek bağlantılı havuz: A transaction'ından sonra aynı bağlantıda kiracı bağlamı kalmaz", async () => {
    // max: 1 → sonraki her checkout AYNI istemci bağlantısıdır (PgBouncer'da aynı sunucu bağlantısı garanti değildir;
    // bu yüzden hem istemci havuzu hem pooled uç ayrı ayrı doğrulanır).
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const c1 = await pool.connect();
      await c1.query("begin");
      await c1.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      expect((await c1.query("select id from kliniva.patients where id = $1", [patientA])).rowCount).toBe(1);
      await c1.query("commit");
      c1.release();

      const c2 = await pool.connect();
      expect(c2).toBe(c1); // aynı bağlantı nesnesi yeniden verildi
      const ctx = await c2.query("select current_setting('app.tenant_id', true) as v");
      expect(ctx.rows[0]?.v ?? "").toBe("");
      expect((await c2.query("select 1 from kliniva.patients")).rowCount).toBe(0);
      // B bağlamında A'nın satırı görünmez
      await c2.query("begin");
      await c2.query("select set_config('app.tenant_id', $1, true)", [B.id]);
      expect((await c2.query("select id from kliniva.patients where id = $1", [patientA])).rowCount).toBe(0);
      await c2.query("rollback");
      c2.release();

      // Hata ile biten (ROLLBACK) transaction da bağlam bırakmaz
      const c3 = await pool.connect();
      await c3.query("begin");
      await c3.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      await expect(c3.query("select 1/0")).rejects.toBeTruthy();
      await c3.query("rollback");
      const after = await c3.query("select current_setting('app.tenant_id', true) as v");
      expect(after.rows[0]?.v ?? "").toBe("");
      expect((await c3.query("select 1 from kliniva.patients")).rowCount).toBe(0);
      c3.release();
    } finally {
      await pool.end();
    }
  });

  it("uygulamanın tenantQuery'si: A/B dönüşümlü ve eşzamanlı 40 istek — sızıntı yok, bağlamsız sorgu 0 satır", async () => {
    const ctxA = A.users.owner!.ctx;
    const ctxB = B.users.owner!.ctx;
    const seen = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const ctx = i % 2 === 0 ? ctxA : ctxB;
        return tenantQuery(ctx, async (scope) => {
          const r = await scope.tx.execute<{ tenant_id: string; ctx: string }>(
            sql`select tenant_id, current_setting('app.tenant_id', true) as ctx from kliniva.patients`,
          );
          return { expected: ctx.tenantId, rows: r.rows };
        });
      }),
    );
    for (const s of seen) {
      expect(s.rows.length).toBeGreaterThan(0);
      expect(s.rows.every((r) => r.tenant_id === s.expected && r.ctx === s.expected)).toBe(true);
    }
    // Havuzdaki her bağlantıda bağlam temiz
    const checks = await Promise.all(
      Array.from({ length: 6 }, () =>
        getPool().query(
          "select current_setting('app.tenant_id', true) as v, (select count(*)::int from kliniva.patients) as n",
        ),
      ),
    );
    for (const c of checks) {
      expect(c.rows[0]?.v ?? "").toBe("");
      expect(c.rows[0]?.n).toBe(0);
    }
  });

  it("oturum düzeyinde SET kullanılmaz: tenantQuery sonrası pg_settings'te kalıcı değer yok", async () => {
    await tenantQuery(A.users.owner!.ctx, async () => undefined);
    const r = await getPool().query("select coalesce(current_setting('app.tenant_id', true), '') as v");
    expect(r.rows[0]?.v).toBe("");
  });
});
