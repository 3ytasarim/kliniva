import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { getMigrationDb } from "@/server/db/migration-client";
import { platformAdmins, platformAuditLogs, users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { hashPassword } from "@/server/security/password";
import { encryptField, sha256Hex } from "@/server/security/crypto";
import { generateTotpSecret, timeStep, totpAt } from "@/server/security/totp";
import {
  authenticatePlatform,
  platformLogin,
  platformMfaSetupInfo,
  platformVerifyMfa,
  resolvePlatformSession,
  type PlatformContext,
} from "@/server/platform/auth";
import {
  createClinic,
  listClinicOwners,
  listClinics,
  randomClinicCode,
  resetOwnerPassword,
  setClinicStatus,
} from "@/server/platform/clinics";
import { login } from "@/server/auth/login";
import { authenticate } from "@/server/auth/context";
import { changeOwnPassword } from "@/server/services/account";
import { createUser } from "@/server/services/users";
import { runInTenant } from "@/server/tenant/tenant-query";
import {
  cleanupTenants,
  createTenant,
  dbError,
  freshMeta,
  trackTenantForCleanup,
  type TestTenant,
} from "../support/fixtures";

/**
 * Sprint 9 — platform yönetimi: zorunlu iki adımlı doğrulama, oturum doğrulayan DB fonksiyonları, klinik açma,
 * kullanıcı adıyla giriş, geçici parola → zorunlu değişim, askıya alma, sahip parolası sıfırlama, yetki sınırları.
 */
const PW = `Plat-${randomBytes(6).toString("base64url")}-9x`;
const OWNER_PW = `Own-${randomBytes(6).toString("base64url")}-7y`;
const adminEmails: string[] = [];
let ACTIVE: PlatformContext;
let T: TestTenant;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};

async function insertAdmin(opts: { withMfa: boolean }) {
  const email = `pa-${randomBytes(4).toString("hex")}@platform.test`;
  adminEmails.push(email);
  const [row] = await getMigrationDb()
    .insert(platformAdmins)
    .values({
      email,
      emailNormalized: email,
      displayName: "Test Sahip",
      passwordHash: await hashPassword(PW),
    })
    .returning({ id: platformAdmins.id });
  let secret: string | null = null;
  if (opts.withMfa) {
    secret = generateTotpSecret();
    await getMigrationDb()
      .update(platformAdmins)
      .set({
        twoFactorEnabled: true,
        twoFactorSecretEncrypted: encryptField(secret, `platform.totp:${row!.id}`),
      })
      .where(eq(platformAdmins.id, row!.id));
  }
  return { id: row!.id, email, secret };
}

async function activeContext(email: string, secret: string): Promise<PlatformContext> {
  const meta = freshMeta();
  const l = await platformLogin({ email, password: PW }, meta);
  if (!l.ok) throw new Error("login failed");
  const m = await platformVerifyMfa(l.token, totpAt(secret, timeStep()), meta);
  if (!m.ok) throw new Error("mfa failed");
  const ctx = await authenticatePlatform(m.token, meta);
  if (!ctx) throw new Error("ctx");
  return ctx;
}

beforeAll(async () => {
  T = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  const a = await insertAdmin({ withMfa: true });
  ACTIVE = await activeContext(a.email, a.secret!);
}, 120_000);

afterAll(async () => {
  const db = getMigrationDb();
  const ids = (
    await db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(inArray(platformAdmins.emailNormalized, adminEmails))
  ).map((r) => r.id);
  if (ids.length) {
    await db.delete(platformAuditLogs).where(inArray(platformAuditLogs.adminId, ids));
    await db.delete(platformAdmins).where(inArray(platformAdmins.id, ids));
  }
  await cleanupTenants();
});

describe("Platform kimlik doğrulaması", () => {
  it("ilk giriş: MFA kurulumu zorunlu; kod olmadan ACTIVE oturum yok; yanlış kod reddedilir; tekrar oynatma yok", async () => {
    const a = await insertAdmin({ withMfa: false });
    const meta = freshMeta();
    expect((await platformLogin({ email: a.email, password: "yanlis-parola-1" }, meta)).ok).toBe(false);
    const l = await platformLogin({ email: a.email, password: PW }, meta);
    expect(l).toMatchObject({ ok: true, next: "MFA_SETUP" });
    if (!l.ok) return;
    expect(await authenticatePlatform(l.token, meta)).toBeNull();
    const s = (await resolvePlatformSession(l.token))!;
    const info = (await platformMfaSetupInfo(s))!;
    expect(info.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(await platformVerifyMfa(l.token, "000000", meta)).toMatchObject({
      ok: false,
      code: "INVALID_CODE",
    });
    const codeNow = totpAt(info.secret, timeStep());
    const ok = await platformVerifyMfa(l.token, codeNow, meta);
    expect(ok.ok).toBe(true);
    // Eski (MFA_SETUP) token artık geçersiz; aynı kod tekrar kullanılamaz
    expect(await resolvePlatformSession(l.token)).toBeNull();
    const l2 = await platformLogin({ email: a.email, password: PW }, freshMeta());
    expect(l2).toMatchObject({ ok: true, next: "MFA_PENDING" });
    if (l2.ok) expect((await platformVerifyMfa(l2.token, codeNow, meta)).ok).toBe(false);
  });

  it("DB fonksiyonları ACTIVE platform oturumu olmadan çalışmaz; uygulama rolü platform yöneticisi ekleyemez", async () => {
    const fake = sha256Hex("yok");
    const err = await dbError(getDb().execute(sql`select * from kliniva.platform_list_tenants(${fake})`));
    expect(err.message).toMatch(/KLINIVA_FORBIDDEN/);
    // MFA_PENDING oturumunun token özeti de geçmez
    const a = await insertAdmin({ withMfa: true });
    const l = await platformLogin({ email: a.email, password: PW }, freshMeta());
    if (!l.ok) throw new Error("login");
    const pending = await resolvePlatformSession(l.token);
    const err2 = await dbError(
      getDb().execute(sql`select * from kliniva.platform_list_tenants(${pending!.tokenHash})`),
    );
    expect(err2.message).toMatch(/KLINIVA_FORBIDDEN/);
    expect(
      (
        await dbError(
          getDb()
            .insert(platformAdmins)
            .values({ email: "x@y.z", emailNormalized: "x@y.z", displayName: "x", passwordHash: "x" }),
        )
      ).code,
    ).toBe("42501");
    expect(
      (
        await dbError(
          getDb().execute(sql`insert into kliniva.tenants (name, slug) values ('x', 'kl-xxxxxx')`),
        )
      ).code,
    ).toBe("42501");
    expect((await dbError(getDb().delete(platformAuditLogs))).code).toBe("42501");
    expect(randomClinicCode()).toMatch(/^kl-[a-z2-9]{6}$/);
  });
});

describe("Klinik açma ve klinik yöneticisi", () => {
  it("klinik açılır → kullanıcı adıyla giriş → geçici parola zorunlu değişim; askıya alma; sahip parolası sıfırlama", async () => {
    expect(
      await code(
        createClinic(ACTIVE, {
          name: "K",
          city: "İst",
          ownerFirstName: "A",
          ownerLastName: "B",
          ownerPassword: OWNER_PW,
        }),
      ),
    ).toBe("VALIDATION");
    const username = `yon${randomBytes(3).toString("hex")}`;
    const c = await createClinic(ACTIVE, {
      name: "Platform Test Kliniği",
      city: "İstanbul",
      ownerFirstName: "Ayşe",
      ownerLastName: "Yönetici",
      ownerUsername: username.toUpperCase(),
      ownerPassword: OWNER_PW,
    });
    trackTenantForCleanup(c.tenantId);
    expect(c.clinicCode).toMatch(/^kl-[a-z2-9]{6}$/);
    expect(c.loginId).toBe(username);
    const row = (await listClinics(ACTIVE)).find((x) => x.id === c.tenantId)!;
    expect(row).toMatchObject({
      slug: c.clinicCode,
      status: "ACTIVE",
      usersTotal: 1,
      branchesTotal: 1,
      patientsTotal: 0,
    });
    const owners = await listClinicOwners(ACTIVE, c.tenantId);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ username, email: null, mustChangePassword: true });

    // Kullanıcı adıyla giriş (büyük harf de olur) → oturum açılır ama parola değişimi zorunlu
    const meta = freshMeta();
    const l = await login(
      { tenantSlug: c.clinicCode, email: username.toUpperCase(), password: OWNER_PW },
      meta,
    );
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    const ctx = (await authenticate(l.token, meta))!;
    expect(ctx.user).toMatchObject({ username, mustChangePassword: true });
    expect(ctx.permissions.has("user.manage")).toBe(true);
    const NEW_PW = `Yeni-${randomBytes(6).toString("base64url")}-4z`;
    expect(
      await code(
        changeOwnPassword(ctx, {
          currentPassword: "yanlis-parola-1",
          newPassword: NEW_PW,
          confirmPassword: NEW_PW,
        }),
      ),
    ).toBe("VALIDATION");
    expect(
      await code(
        changeOwnPassword(ctx, {
          currentPassword: OWNER_PW,
          newPassword: OWNER_PW,
          confirmPassword: OWNER_PW,
        }),
      ),
    ).toBe("VALIDATION");
    await changeOwnPassword(ctx, { currentPassword: OWNER_PW, newPassword: NEW_PW, confirmPassword: NEW_PW });
    expect((await authenticate(l.token, meta))!.user.mustChangePassword).toBe(false);

    // Klinik yöneticisi personel açar: yalnızca kullanıcı adıyla; yeni kullanıcı da geçici parolayla başlar
    await createUser(ctx, {
      username: "resepsiyon.1",
      firstName: "Res",
      lastName: "Ep",
      password: OWNER_PW,
      roles: [{ roleKey: "RECEPTION", branchId: null }],
    });
    expect(
      await code(
        createUser(ctx, {
          username: "Resepsiyon.1",
          firstName: "X",
          lastName: "Y",
          password: OWNER_PW,
          roles: [{ roleKey: "RECEPTION", branchId: null }],
        }),
      ),
    ).toBe("CONFLICT");
    const rl = await login(
      { tenantSlug: c.clinicCode, email: "resepsiyon.1", password: OWNER_PW },
      freshMeta(),
    );
    expect(rl.ok).toBe(true);
    if (rl.ok) expect((await authenticate(rl.token, freshMeta()))!.user.mustChangePassword).toBe(true);

    // Askıya alma: mevcut oturum düşer, giriş yapılamaz; yeniden etkinleştirme
    await setClinicStatus(ACTIVE, c.tenantId, "SUSPENDED");
    expect(await authenticate(l.token, meta)).toBeNull();
    expect(
      (await login({ tenantSlug: c.clinicCode, email: username, password: NEW_PW }, freshMeta())).ok,
    ).toBe(false);
    await setClinicStatus(ACTIVE, c.tenantId, "ACTIVE");
    expect(
      (await login({ tenantSlug: c.clinicCode, email: username, password: NEW_PW }, freshMeta())).ok,
    ).toBe(true);

    // Sahip parolası sıfırlama: eski parola geçmez, yenisi geçici
    const RESET_PW = `Sifir-${randomBytes(6).toString("base64url")}-2w`;
    await resetOwnerPassword(ACTIVE, c.tenantId, owners[0]!.userId, RESET_PW);
    expect(
      (await login({ tenantSlug: c.clinicCode, email: username, password: NEW_PW }, freshMeta())).ok,
    ).toBe(false);
    const l3 = await login({ tenantSlug: c.clinicCode, email: username, password: RESET_PW }, freshMeta());
    expect(l3.ok).toBe(true);
    if (l3.ok) expect((await authenticate(l3.token, freshMeta()))!.user.mustChangePassword).toBe(true);
    // Sahip olmayan kullanıcının parolası platformdan sıfırlanamaz; başka kliniğin sahibi de bu kliniğe ait değil
    const rec = await runInTenant(c.tenantId, (s) =>
      s.tx.select({ id: users.id }).from(users).where(eq(users.usernameNormalized, "resepsiyon.1")),
    );
    expect(await code(resetOwnerPassword(ACTIVE, c.tenantId, rec[0]!.id, RESET_PW))).toBe("NOT_FOUND");
    expect(await code(resetOwnerPassword(ACTIVE, c.tenantId, T.users.owner!.id, RESET_PW))).toBe("NOT_FOUND");
    expect(await code(resetOwnerPassword(ACTIVE, c.tenantId, owners[0]!.userId, "kisa"))).toBe("VALIDATION");

    // Platform denetim kaydı: parola / kişisel veri yok
    const audit = await getMigrationDb()
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.targetTenantId, c.tenantId));
    expect(audit.map((x) => x.action).sort()).toEqual([
      "OWNER_PASSWORD_RESET",
      "TENANT_ACTIVATED",
      "TENANT_CREATED",
      "TENANT_SUSPENDED",
    ]);
    expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${OWNER_PW}|${RESET_PW}|${username}`));
  });
});
