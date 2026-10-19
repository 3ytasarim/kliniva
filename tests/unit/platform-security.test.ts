import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCsp, staticSecurityHeaders } from "@/lib/security-headers";
import { isSameOriginRequest } from "@/server/security/origin";
import { requireDatabaseUrl } from "@/server/env";
import { canAccessBranch, requirePermission, type AuthContext } from "@/server/auth/authz";
import { SYSTEM_ROLES } from "@/server/auth/permissions";
import { sessionCookieOptions } from "@/server/auth/session";
import { maskPhone } from "@/server/services/patients";
import { isUuid } from "@/server/validation";

describe("Security headers", () => {
  it("üretim CSP'si: inline script yok, nonce + strict-dynamic, clickjacking koruması", () => {
    const csp = buildCsp("abc123", { dev: false });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("üretimde HSTS, nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options", () => {
    const h = Object.fromEntries(staticSecurityHeaders({ production: true }).map((x) => [x.key, x.value]));
    expect(h["Strict-Transport-Security"]).toMatch(/max-age=\d{8}/);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toContain("camera=()");
    expect(h["X-Frame-Options"]).toBe("DENY");
    // Geliştirmede HSTS gönderilmez (localhost'u kilitlememek için).
    expect(
      staticSecurityHeaders({ production: false }).some((x) => x.key === "Strict-Transport-Security"),
    ).toBe(false);
  });
});

describe("CSRF / origin kontrolü", () => {
  const req = (method: string, headers: Record<string, string>) =>
    new Request("http://localhost:3000/api/v1/patients", { method, headers });

  it("aynı origin'den POST kabul, başka origin'den red", () => {
    expect(
      isSameOriginRequest(req("POST", { origin: "http://localhost:3000", host: "localhost:3000" })),
    ).toBe(true);
    expect(isSameOriginRequest(req("POST", { origin: "https://evil.example", host: "localhost:3000" }))).toBe(
      false,
    );
    expect(isSameOriginRequest(req("POST", { origin: "null", host: "localhost:3000" }))).toBe(false);
  });

  it("Origin yoksa yalnızca Sec-Fetch-Site: same-origin kabul edilir", () => {
    expect(isSameOriginRequest(req("PATCH", { "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(req("PATCH", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginRequest(req("DELETE", {}))).toBe(false);
  });

  it("GET güvenli metottur", () => {
    expect(isSameOriginRequest(req("GET", { origin: "https://evil.example" }))).toBe(true);
  });
});

describe("Ortam değişkenleri / sırlar", () => {
  it("DATABASE_URL yoksa güvenli hata: 'DATABASE_URL is required'", () => {
    expect(() => requireDatabaseUrl({} as unknown as NodeJS.ProcessEnv)).toThrow(
      /^DATABASE_URL is required$/,
    );
    expect(() => requireDatabaseUrl({ DATABASE_URL: "  " } as unknown as NodeJS.ProcessEnv)).toThrow(
      "DATABASE_URL is required",
    );
  });

  it(".env dosyaları Git tarafından ignore edilir, .env.example edilmez", () => {
    const ignored = (p: string) => {
      try {
        execFileSync("git", ["check-ignore", "-q", "--no-index", p], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    for (const f of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.development.local",
      "secrets.env",
      ".private-storage/x.png",
    ]) {
      expect(ignored(f), f).toBe(true);
    }
    expect(ignored(".env.example")).toBe(false);
  });

  it("kaynak kodda bağlantı dizesi / gömülü anahtar yok", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => /\.(ts|tsx|mts|mjs|js|json|md|sql)$/.test(f) && !f.startsWith("tests/unit/logging"))
      // İndekste olup çalışma ağacından silinmiş / taşınmış dosya içerik taşımaz (commit ile indeksten de çıkar).
      .filter((f) => existsSync(f));
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      expect(content, f).not.toMatch(/postgres(ql)?:\/\/[^\s"'`]+:[^\s"'`@]+@/);
      expect(content, f).not.toMatch(/APP_ENCRYPTION_KEY=[A-Za-z0-9+/]{40,}/);
    }
  });
});

describe("Oturum çerezi", () => {
  it("HttpOnly, SameSite=Lax, Path=/; Secure yalnızca üretimde", () => {
    const o = sessionCookieOptions(new Date(Date.now() + 1000));
    expect(o.httpOnly).toBe(true);
    expect(o.sameSite).toBe("lax");
    expect(o.path).toBe("/");
    expect(o.secure).toBe(process.env.NODE_ENV === "production");
  });
});

describe("RBAC kataloğu ve şube kapsamı", () => {
  const base = {
    tenantId: "t",
    userId: "u",
    sessionId: "s",
    roles: [],
    meta: { ipHash: null, userAgentSummary: null },
    user: { firstName: "", lastName: "", email: "", twoFactorEnabled: false },
  };

  it("RECEPTION sağlık verisi yetkisine sahip değil; DOCTOR sahip", () => {
    expect(SYSTEM_ROLES.RECEPTION.permissions).not.toContain("patient.health.read");
    expect(SYSTEM_ROLES.RECEPTION.permissions).not.toContain("patient.health.write");
    expect(SYSTEM_ROLES.DOCTOR.permissions).toContain("patient.health.read");
    expect(SYSTEM_ROLES.PLATFORM_SUPER_ADMIN.permissions).toHaveLength(0);
  });

  it("requirePermission eksik yetkide FORBIDDEN fırlatır", () => {
    const ctx = {
      ...base,
      permissions: new Set(["patient.read"]),
      branchScope: { all: true },
    } as unknown as AuthContext;
    expect(() => requirePermission(ctx, "patient.read")).not.toThrow();
    expect(() => requirePermission(ctx, "patient.health.read")).toThrowError(/yetkiniz yok/);
  });

  it("şube kapsamlı kullanıcı yalnızca kendi şubesine erişir", () => {
    const ctx = {
      ...base,
      permissions: new Set(),
      branchScope: { all: false, branchIds: new Set(["b1"]) },
    } as unknown as AuthContext;
    expect(canAccessBranch(ctx, "b1")).toBe(true);
    expect(canAccessBranch(ctx, "b2")).toBe(false);
    expect(canAccessBranch(ctx, null)).toBe(false);
  });
});

describe("Yardımcılar", () => {
  it("telefon listede maskelenir", () => {
    expect(maskPhone("0532 123 45 67")).toBe("*******4567");
  });
  it("geçersiz UUID tanınır", () => {
    expect(isUuid("6f1c1b7e-1111-4a1a-9a1a-111111111111")).toBe(true);
    expect(isUuid("1 OR 1=1")).toBe(false);
    expect(isUuid("../../etc/passwd")).toBe(false);
  });
});
