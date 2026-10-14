import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import { createPatient, getPatient, listPatients, updatePatient } from "@/server/services/patients";
import { getBranch, listBranches } from "@/server/services/org";
import { createUser } from "@/server/services/users";
import { GET as listRoute, POST as createRoute } from "@/app/api/v1/patients/route";
import { GET as getRoute } from "@/app/api/v1/patients/[id]/route";
import {
  apiRequest,
  cleanupTenants,
  createTenant,
  params,
  TEST_PASSWORD,
  type TestTenant,
} from "../support/fixtures";

let T: TestTenant;
let patientInA: string;
let patientInB: string;
const NOTE = "Hastada hipertansiyon öyküsü — gizli";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};

beforeAll(async () => {
  T = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    admin: { role: "CLINIC_ADMIN" },
    managerA: { role: "BRANCH_MANAGER", branch: "A" },
    doctor: { role: "DOCTOR" },
    reception: { role: "RECEPTION" },
    readonly: { role: "READ_ONLY" },
  });
  patientInA = (
    await createPatient(T.users.doctor!.ctx, {
      firstName: "Can",
      lastName: "Şube-A",
      phone: "05321110001",
      branchId: T.branchA,
      notes: NOTE,
    })
  ).id;
  patientInB = (
    await createPatient(T.users.doctor!.ctx, {
      firstName: "Deniz",
      lastName: "Şube-B",
      phone: "05321110002",
      branchId: T.branchB,
    })
  ).id;
});

afterAll(cleanupTenants);

describe("Branch manager yetkisi olmayan şubeye erişemez", () => {
  it("kendi şubesinin hastasını okur, diğer şubeninkini okuyamaz", async () => {
    const ctx = T.users.managerA!.ctx;
    expect((await getPatient(ctx, patientInA)).id).toBe(patientInA);
    expect(await code(getPatient(ctx, patientInB))).toBe("NOT_FOUND");
  });

  it("listede yalnızca kendi şubesi", async () => {
    const ids = (await listPatients(T.users.managerA!.ctx)).map((p) => p.id);
    expect(ids).toContain(patientInA);
    expect(ids).not.toContain(patientInB);
    const branchIds = (await listBranches(T.users.managerA!.ctx)).map((b) => b.id);
    expect(branchIds).toEqual([T.branchA]);
    expect(await code(getBranch(T.users.managerA!.ctx, T.branchB))).toBe("NOT_FOUND");
  });

  it("diğer şubeye hasta oluşturamaz / güncelleyemez", async () => {
    const ctx = T.users.managerA!.ctx;
    expect(
      await code(
        createPatient(ctx, { firstName: "X", lastName: "Y", phone: "05320000000", branchId: T.branchB }),
      ),
    ).toBe("FORBIDDEN");
    expect(await code(updatePatient(ctx, patientInB, { firstName: "Z" }))).toBe("NOT_FOUND");
    expect(await code(updatePatient(ctx, patientInA, { branchId: T.branchB }))).toBe("FORBIDDEN");
  });
});

describe("RECEPTION patient.health.read olmadan sağlık verisini göremez", () => {
  it("hasta detayında sağlık alanı hiç yok", async () => {
    const p = await getPatient(T.users.reception!.ctx, patientInA);
    expect(p.firstName).toBe("Can");
    expect(p.health).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("hipertansiyon");
  });

  it("API yanıtında da sağlık verisi yok", async () => {
    const res = await getRoute(
      apiRequest(`/api/v1/patients/${patientInA}`, { token: T.users.reception!.token }),
      params(patientInA),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("hipertansiyon");
  });

  it("doktor (patient.health.read) notu çözülmüş görür", async () => {
    const p = await getPatient(T.users.doctor!.ctx, patientInA);
    expect(p.health?.notes).toBe(NOTE);
  });

  it("RECEPTION tıbbi not yazamaz", async () => {
    expect(
      await code(
        createPatient(T.users.reception!.ctx, {
          firstName: "E",
          lastName: "F",
          phone: "05320000003",
          branchId: T.branchA,
          notes: "x",
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(await code(updatePatient(T.users.reception!.ctx, patientInA, { notes: "üzerine yaz" }))).toBe(
      "FORBIDDEN",
    );
  });

  it("CLINIC_ADMIN (idari) de varsayılan olarak sağlık verisi görmez", async () => {
    expect((await getPatient(T.users.admin!.ctx, patientInA)).health).toBeUndefined();
  });
});

describe("Yetkisiz kullanıcı patient endpoint'lerine erişemez", () => {
  it("oturumsuz → 401", async () => {
    expect((await listRoute(apiRequest("/api/v1/patients"))).status).toBe(401);
    expect((await getRoute(apiRequest(`/api/v1/patients/${patientInA}`), params(patientInA))).status).toBe(
      401,
    );
    const post = await createRoute(
      apiRequest("/api/v1/patients", { method: "POST", body: { firstName: "a" } }),
    );
    expect(post.status).toBe(401);
  });

  it("sahte / rastgele token → 401", async () => {
    const res = await listRoute(apiRequest("/api/v1/patients", { token: "x".repeat(43) }));
    expect(res.status).toBe(401);
  });

  it("patient.read yetkisi olmayan (READ_ONLY) → 403", async () => {
    expect((await listRoute(apiRequest("/api/v1/patients", { token: T.users.readonly!.token }))).status).toBe(
      403,
    );
    expect(
      (
        await getRoute(
          apiRequest(`/api/v1/patients/${patientInA}`, { token: T.users.readonly!.token }),
          params(patientInA),
        )
      ).status,
    ).toBe(403);
  });

  it("yetkili kullanıcı listede maskeli telefon görür (minimum veri)", async () => {
    const res = await listRoute(apiRequest("/api/v1/patients", { token: T.users.reception!.token }));
    const body = (await res.json()) as { data: { phoneMasked: string }[] };
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("05321110001");
    expect(body.data.some((p) => p.phoneMasked.endsWith("0001"))).toBe(true);
  });

  it("başka origin'den POST → 403 (CSRF)", async () => {
    const res = await createRoute(
      apiRequest("/api/v1/patients", {
        method: "POST",
        token: T.users.owner!.token,
        origin: "https://evil.example",
        body: { firstName: "a", lastName: "b", phone: "05320000009" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("Zod doğrulaması: geçersiz gövde → 400, değerler yanıtta yansıtılmaz", async () => {
    const res = await createRoute(
      apiRequest("/api/v1/patients", {
        method: "POST",
        token: T.users.owner!.token,
        body: { firstName: "<script>alert(1)</script>", lastName: "", phone: "abc" },
      }),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("<script>");
    expect(text).toContain("VALIDATION");
  });
});

describe("Yetki yükseltme koruması", () => {
  it("CLINIC_ADMIN, kendisinde olmayan sağlık yetkili DOCTOR rolünü atayamaz", async () => {
    expect(
      await code(
        createUser(T.users.admin!.ctx, {
          email: "d2@x.test",
          firstName: "D",
          lastName: "R",
          password: TEST_PASSWORD,
          roles: [{ roleKey: "DOCTOR", branchId: null }],
        }),
      ),
    ).toBe("FORBIDDEN");
  });

  it("PLATFORM_SUPER_ADMIN hiçbir zaman kiracı içinden atanamaz", async () => {
    expect(
      await code(
        createUser(T.users.owner!.ctx, {
          email: "p@x.test",
          firstName: "P",
          lastName: "A",
          password: TEST_PASSWORD,
          roles: [{ roleKey: "PLATFORM_SUPER_ADMIN", branchId: null }],
        }),
      ),
    ).toBe("FORBIDDEN");
  });

  it("CLINIC_ADMIN RECEPTION oluşturabilir; zayıf parola reddedilir", async () => {
    expect(
      await code(
        createUser(T.users.admin!.ctx, {
          email: "r2@x.test",
          firstName: "R",
          lastName: "2",
          password: TEST_PASSWORD,
          roles: [{ roleKey: "RECEPTION", branchId: T.branchA }],
        }),
      ),
    ).toBe("OK");
    expect(
      await code(
        createUser(T.users.admin!.ctx, {
          email: "r3@x.test",
          firstName: "R",
          lastName: "3",
          password: "kisa",
          roles: [{ roleKey: "RECEPTION", branchId: null }],
        }),
      ),
    ).toBe("VALIDATION");
  });

  it("BRANCH_MANAGER kullanıcı yönetemez", async () => {
    expect(
      await code(
        createUser(T.users.managerA!.ctx, {
          email: "m@x.test",
          firstName: "M",
          lastName: "X",
          password: TEST_PASSWORD,
          roles: [{ roleKey: "READ_ONLY", branchId: T.branchA }],
        }),
      ),
    ).toBe("FORBIDDEN");
  });
});
