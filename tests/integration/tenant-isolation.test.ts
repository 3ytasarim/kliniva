import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/server/db/client";
import { AppError } from "@/server/errors";
import { createPatient, getPatient, listPatients, updatePatient } from "@/server/services/patients";
import { createRoom, getBranch, listBranches } from "@/server/services/org";
import { GET as getPatientRoute, PATCH as patchPatientRoute } from "@/app/api/v1/patients/[id]/route";
import { apiRequest, cleanupTenants, createTenant, params, type TestTenant } from "../support/fixtures";

/**
 * Kiracı izolasyonu — üç katman birlikte test edilir:
 *   servis katmanı (tenantWhere), API katmanı (route handler) ve veritabanı (RLS FORCE + bileşik FK).
 */
let A: TestTenant;
let B: TestTenant;
let patientA: string;
let patientB: string;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};

beforeAll(async () => {
  A = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  patientA = (
    await createPatient(A.users.owner!.ctx, {
      firstName: "Ali",
      lastName: "Kiracı-A",
      phone: "05320000001",
      branchId: A.branchA,
      notes: "A kiracısı tıbbi notu",
    })
  ).id;
  patientB = (
    await createPatient(B.users.owner!.ctx, {
      firstName: "Burcu",
      lastName: "Kiracı-B",
      phone: "05320000002",
      branchId: B.branchA,
      notes: "B kiracısı gizli tıbbi notu",
    })
  ).id;
});

afterAll(cleanupTenants);

describe("Tenant A kullanıcısı Tenant B verisini OKUYAMAZ", () => {
  it("getPatient(B'nin hastası) → NOT_FOUND (varlık sızdırmaz)", async () => {
    expect(await code(getPatient(A.users.owner!.ctx, patientB))).toBe("NOT_FOUND");
  });

  it("listPatients yalnızca kendi kiracısının hastalarını döner", async () => {
    const list = await listPatients(A.users.owner!.ctx);
    expect(list.map((p) => p.id)).toContain(patientA);
    expect(list.map((p) => p.id)).not.toContain(patientB);
  });

  it("B'nin şubesi listelenmez / okunamaz", async () => {
    const list = await listBranches(A.users.owner!.ctx);
    expect(list.map((b) => b.id)).not.toContain(B.branchA);
    expect(await code(getBranch(A.users.owner!.ctx, B.branchA))).toBe("NOT_FOUND");
  });
});

describe("Tenant A kullanıcısı Tenant B verisini GÜNCELLEYEMEZ", () => {
  it("updatePatient(B'nin hastası) → NOT_FOUND ve B'nin verisi değişmez", async () => {
    expect(await code(updatePatient(A.users.owner!.ctx, patientB, { firstName: "Ele Geçirildi" }))).toBe(
      "NOT_FOUND",
    );
    const still = await getPatient(B.users.owner!.ctx, patientB);
    expect(still.firstName).toBe("Burcu");
  });

  it("B'nin şubesine oda eklenemez", async () => {
    expect(await code(createRoom(A.users.owner!.ctx, { branchId: B.branchA, name: "Sızma" }))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("Cross-tenant IDOR (API)", () => {
  it("GET /api/v1/patients/:B-id → 404, gövdede B verisi yok", async () => {
    const res = await getPatientRoute(
      apiRequest(`/api/v1/patients/${patientB}`, { token: A.users.owner!.token }),
      params(patientB),
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("Burcu");
    expect(text).not.toContain("gizli");
  });

  it("PATCH /api/v1/patients/:B-id → 404", async () => {
    const res = await patchPatientRoute(
      apiRequest(`/api/v1/patients/${patientB}`, {
        method: "PATCH",
        token: A.users.owner!.token,
        body: { lastName: "X" },
      }),
      params(patientB),
    );
    expect(res.status).toBe(404);
  });

  it("geçersiz UUID güvenli 404 döner (SQL/stack sızmaz)", async () => {
    for (const bad of [
      "not-a-uuid",
      "1' OR '1'='1",
      "../../etc/passwd",
      "00000000-0000-0000-0000-000000000000",
    ]) {
      const res = await getPatientRoute(
        apiRequest(`/api/v1/patients/${encodeURIComponent(bad)}`, { token: A.users.owner!.token }),
        params(bad),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("NOT_FOUND");
      expect(JSON.stringify(body)).not.toMatch(/select|syntax|stack|at \w+ \(/i);
    }
  });
});

describe("Veritabanı katmanı: RLS (FORCE) + bileşik FK", () => {
  it("bağlantı rolü RLS'i atlamaz (aksi halde RLS etkisiz olurdu)", async () => {
    const r = await getPool().query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("kiracı bağlamı olmadan ham sorgu hiçbir hasta satırı göremez", async () => {
    const r = await getPool().query("select id from kliniva.patients where id = any($1::uuid[])", [
      [patientA, patientB],
    ]);
    expect(r.rowCount).toBe(0);
  });

  it("A bağlamında, uygulama filtresi OLMADAN bile B'nin satırı görünmez", async () => {
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      const r = await client.query("select id from kliniva.patients where id = any($1::uuid[])", [
        [patientA, patientB],
      ]);
      expect(r.rows.map((x) => x.id)).toEqual([patientA]);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("A bağlamında B'nin tenant_id'siyle satır yazılamaz (RLS WITH CHECK)", async () => {
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      await expect(
        client.query("insert into kliniva.branches (tenant_id, name, city) values ($1, 'x', 'y')", [B.id]),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("A'nın odası B'nin şubesine bağlanamaz (bileşik FK)", async () => {
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      await expect(
        client.query("insert into kliniva.rooms (tenant_id, branch_id, name) values ($1, $2, 'x')", [
          A.id,
          B.branchA,
        ]),
      ).rejects.toMatchObject({ code: "23503" });
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});
