import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { authenticate } from "@/server/auth/context";
import { login, logout, verifyMfaLogin } from "@/server/auth/login";
import { resolveSession } from "@/server/auth/session";
import { auditLogs, users } from "@/server/db/schema";
import { runInTenant } from "@/server/tenant/tenant-query";
import { confirmMfaEnrollment, startMfaEnrollment } from "@/server/services/mfa";
import { setUserActive } from "@/server/services/users";
import { timeStep, totpAt } from "@/server/security/totp";
import { GET as listRoute } from "@/app/api/v1/patients/route";
import {
  apiRequest,
  cleanupTenants,
  createTenant,
  freshMeta,
  TEST_PASSWORD,
  type TestTenant,
} from "../support/fixtures";

let T: TestTenant;

beforeAll(async () => {
  T = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    doctor: { role: "DOCTOR" },
    disabled: { role: "RECEPTION", active: false },
    brute: { role: "RECEPTION" },
    mfa: { role: "DOCTOR" },
    rotator: { role: "RECEPTION" },
  });
});

afterAll(cleanupTenants);

const creds = (name: string, password = TEST_PASSWORD) => ({
  tenantSlug: T.slug,
  email: T.users[name]!.email,
  password,
});

describe("Login", () => {
  it("parola Argon2id ile saklanır", async () => {
    const [u] = await runInTenant(T.id, (s) =>
      s.tx
        .select({ h: users.passwordHash })
        .from(users)
        .where(and(eq(users.tenantId, s.tenantId), eq(users.id, T.users.owner!.id))),
    );
    expect(u!.h.startsWith("$argon2id$")).toBe(true);
  });

  it("yanlış parola başarısız olur ve LOGIN_FAILED audit'lenir (parola yazılmadan)", async () => {
    const res = await login(creds("doctor", "Yanlis-Parola-123"), freshMeta());
    expect(res).toEqual({ ok: false, code: "INVALID_CREDENTIALS" });
    const rows = await runInTenant(T.id, (s) =>
      s.tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.tenantId, s.tenantId), eq(auditLogs.action, "LOGIN_FAILED"))),
    );
    expect(rows.some((r) => r.metadataSafe.reason === "BAD_PASSWORD")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("Yanlis-Parola-123");
  });

  it("pasif (disabled) kullanıcı doğru parolayla da giriş yapamaz; mevcut oturumu da geçersizdir", async () => {
    expect(await login(creds("disabled"), freshMeta())).toEqual({ ok: false, code: "INVALID_CREDENTIALS" });
    expect(await authenticate(T.users.disabled!.token, freshMeta())).toBeNull();
  });

  it("bilinmeyen klinik / kullanıcı aynı genel hatayı döner (keşif yok)", async () => {
    expect(await login({ ...creds("doctor"), tenantSlug: "yok-boyle-klinik" }, freshMeta())).toEqual({
      ok: false,
      code: "INVALID_CREDENTIALS",
    });
    expect(await login({ ...creds("doctor"), email: "kimse@yok.test" }, freshMeta())).toEqual({
      ok: false,
      code: "INVALID_CREDENTIALS",
    });
  });

  it("geçersiz girdi (Zod) güvenli şekilde reddedilir", async () => {
    expect(await login({ tenantSlug: "../../x", email: 1, password: null }, freshMeta())).toEqual({
      ok: false,
      code: "INVALID_CREDENTIALS",
    });
  });
});

describe("Login rate limit", () => {
  it("5 başarısız denemeden sonra doğru parola bile RATE_LIMITED", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(creds("brute", `Yanlis-Deneme-${i}x`), freshMeta())).ok).toBe(false);
    }
    expect(await login(creds("brute"), freshMeta())).toEqual({ ok: false, code: "RATE_LIMITED" });
  });

  it("aynı IP'den çok sayıda hesap denemesi IP kuralına takılır", async () => {
    const meta = freshMeta();
    let last;
    for (let i = 0; i < 31; i++) {
      last = await login({ tenantSlug: T.slug, email: `yok${i}@x.test`, password: "Bilinmeyen-123x" }, meta);
    }
    expect(last).toEqual({ ok: false, code: "RATE_LIMITED" });
  }, 120_000);
});

describe("Oturum", () => {
  it("logout sonrası oturum (token) kullanılamaz", async () => {
    const res = await login(creds("doctor"), freshMeta());
    if (!res.ok) throw new Error("login failed");
    expect(await authenticate(res.token, freshMeta())).not.toBeNull();
    await logout(res.token, freshMeta());
    expect(await authenticate(res.token, freshMeta())).toBeNull();
    expect((await listRoute(apiRequest("/api/v1/patients", { token: res.token }))).status).toBe(401);
  });

  it("login sonrası session ID döner; önceki token geçersiz olur (fixation koruması)", async () => {
    const first = await login(creds("rotator"), freshMeta());
    if (!first.ok) throw new Error("login failed");
    const second = await login(creds("rotator"), freshMeta(), { previousToken: first.token });
    if (!second.ok) throw new Error("login failed");
    expect(second.token).not.toBe(first.token);
    expect(await resolveSession(first.token)).toBeNull();
    expect(await authenticate(second.token, freshMeta())).not.toBeNull();
  });

  it("kullanıcı pasifleştirilince tüm oturumları anında düşer", async () => {
    const res = await login(creds("rotator"), freshMeta());
    if (!res.ok) throw new Error("login failed");
    await setUserActive(T.users.owner!.ctx, T.users.rotator!.id, false);
    expect(await authenticate(res.token, freshMeta())).toBeNull();
  });
});

describe("MFA (TOTP) — bypass yok", () => {
  it("kurulum → giriş MFA_PENDING → kod olmadan erişim yok → doğru kodla yeni ACTIVE oturum", async () => {
    const ctx = T.users.mfa!.ctx;
    const { secret } = await startMfaEnrollment(ctx);
    const step = timeStep();
    await confirmMfaEnrollment(ctx, totpAt(secret, step - 1));

    const first = await login(creds("mfa"), freshMeta());
    expect(first.ok && first.mfaRequired).toBe(true);
    if (!first.ok) return;
    // MFA bekleyen oturum korunan kaynaklara erişemez.
    expect(await authenticate(first.token, freshMeta())).toBeNull();
    expect((await listRoute(apiRequest("/api/v1/patients", { token: first.token }))).status).toBe(401);

    expect(await verifyMfaLogin(first.token, "000000", freshMeta())).toEqual({
      ok: false,
      code: "INVALID_CODE",
    });
    // Kurulumda kullanılan adım tekrar kullanılamaz (replay).
    expect(await verifyMfaLogin(first.token, totpAt(secret, step - 1), freshMeta())).toEqual({
      ok: false,
      code: "INVALID_CODE",
    });

    const ok = await verifyMfaLogin(first.token, totpAt(secret, step), freshMeta());
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.token).not.toBe(first.token);
    expect(await resolveSession(first.token)).toBeNull(); // bekleyen oturum iptal
    expect(await authenticate(ok.token, freshMeta())).not.toBeNull();

    // Aynı kod ikinci kez kullanılamaz.
    const again = await login(creds("mfa"), freshMeta());
    if (!again.ok) throw new Error("login failed");
    expect(await verifyMfaLogin(again.token, totpAt(secret, step), freshMeta())).toEqual({
      ok: false,
      code: "INVALID_CODE",
    });
  });

  it("MFA sırrı veritabanında şifreli saklanır", async () => {
    const [u] = await runInTenant(T.id, (s) =>
      s.tx
        .select({ secret: users.twoFactorSecretEncrypted, enabled: users.twoFactorEnabled })
        .from(users)
        .where(and(eq(users.tenantId, s.tenantId), eq(users.id, T.users.mfa!.id))),
    );
    expect(u!.enabled).toBe(true);
    expect(u!.secret).toMatch(/^v1\./);
  });
});
