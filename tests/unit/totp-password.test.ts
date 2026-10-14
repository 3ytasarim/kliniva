import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, otpauthUri, totpAt, verifyTotp } from "@/server/security/totp";
import { hashPassword, passwordPolicy, verifyPassword } from "@/server/security/password";

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 Ek B test vektörleri (SHA1, sır "12345678901234567890"), 8 hanenin son 6 hanesi.
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("t=%i → %s", (t, code) => {
    expect(totpAt(secret, Math.floor(t / 30))).toBe(code);
  });

  it("base32 round-trip", () => {
    const buf = Buffer.from("kliniva-secret-bytes");
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it("geçerli kod kabul edilir, aynı adım tekrar kullanılamaz (replay)", () => {
    const now = 1_760_000_000_000;
    const step = Math.floor(now / 30_000);
    const code = totpAt(secret, step);
    const accepted = verifyTotp(secret, code, { nowMs: now });
    expect(accepted).toBe(step);
    expect(verifyTotp(secret, code, { nowMs: now, lastUsedStep: accepted })).toBeNull();
  });

  it("biçimsiz veya yanlış kod reddedilir", () => {
    expect(verifyTotp(secret, "abc123")).toBeNull();
    expect(verifyTotp(secret, "000000", { nowMs: 59_000 })).toBeNull();
  });

  it("otpauth URI issuer içerir", () => {
    expect(otpauthUri({ secret, account: "a@b.c", issuer: "Kliniva AI" })).toMatch(
      /^otpauth:\/\/totp\/Kliniva%20AI/,
    );
  });
});

describe("Parola güvenliği", () => {
  it("Argon2id ile hashlenir ve doğrulanır", async () => {
    const hash = await hashPassword("Gecerli-Parola-2026");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain("m=19456,t=2,p=1");
    expect(await verifyPassword(hash, "Gecerli-Parola-2026")).toBe(true);
    expect(await verifyPassword(hash, "yanlis-parola-2026")).toBe(false);
  });

  it("bozuk hash false döner (exception sızdırmaz)", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });

  it("asgari parola politikası", () => {
    expect(passwordPolicy.safeParse("kisa1").success).toBe(false);
    expect(passwordPolicy.safeParse("sadeceharflerdenoluşan").success).toBe(false);
    expect(passwordPolicy.safeParse("123456789012345").success).toBe(false);
    expect(passwordPolicy.safeParse("Password1234").success).toBe(false); // yaygın
    expect(passwordPolicy.safeParse("Kliniva-Guvenli-42").success).toBe(true);
  });
});
