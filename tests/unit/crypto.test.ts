import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  decryptBytes,
  decryptField,
  encryptBytes,
  encryptField,
  keyedHash,
} from "@/server/security/crypto";

describe("AES-256-GCM alan şifreleme", () => {
  const aad = "patient.notes:tenant-a:patient-1";

  it("encrypt/decrypt round-trip çalışır (Türkçe karakterler dahil)", () => {
    const text = "Hasta penisilin alerjisi bildirdi — ğüşiöç İĞÜŞÖÇ";
    expect(decryptField(encryptField(text, aad), aad)).toBe(text);
  });

  it("şifreli metin versiyon, IV, auth tag ve ciphertext içerir", () => {
    const parts = encryptField("x", aad).split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(Buffer.from(parts[1]!, "base64url")).toHaveLength(12); // IV
    expect(Buffer.from(parts[2]!, "base64url")).toHaveLength(16); // tag
    expect(parts[3]!.length).toBeGreaterThan(0);
  });

  it("nonce (IV) asla tekrar kullanılmaz — 20.000 şifrelemede tümü benzersiz", () => {
    const ivs = new Set<string>();
    const cts = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const [, iv, , ct] = encryptField("aynı düz metin", aad).split(".");
      ivs.add(iv!);
      cts.add(ct!);
    }
    expect(ivs.size).toBe(20_000);
    expect(cts.size).toBe(20_000); // aynı düz metin bile farklı şifreli metin üretir
  });

  it("şifreli metin değiştirilirse çözülmez (bütünlük)", () => {
    const [v, iv, tag, ct] = encryptField("gizli", aad).split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = flipped[0]! ^ 0x01;
    expect(() => decryptField([v, iv, tag, flipped.toString("base64url")].join("."), aad)).toThrow(
      DecryptionError,
    );
  });

  it("farklı AAD (başka hasta/kiracı bağlamı) ile çözülmez", () => {
    const enc = encryptField("gizli", aad);
    expect(() => decryptField(enc, "patient.notes:tenant-b:patient-1")).toThrow(DecryptionError);
  });

  it("yanlış anahtarla çözülmez", () => {
    const enc = encryptField("gizli", aad);
    expect(() => decryptField(enc, aad, randomBytes(32))).toThrow(DecryptionError);
  });

  it("AAD zorunludur", () => {
    expect(() => encryptField("x", "")).toThrow();
  });

  it("ikili veri (imza/PDF) round-trip ve kurcalama tespiti", () => {
    const data = randomBytes(5000);
    const blob = encryptBytes(data, "storage:k");
    expect(decryptBytes(blob, "storage:k").equals(data)).toBe(true);
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    expect(() => decryptBytes(blob, "storage:k")).toThrow(DecryptionError);
  });

  it("hata mesajı anahtar veya düz metin içermez", () => {
    try {
      decryptField("v1.a.b.c", aad);
    } catch (e) {
      expect((e as Error).message).toBe("Decryption failed");
    }
  });

  it("keyedHash deterministik, amaca özel ve geri döndürülemez", () => {
    expect(keyedHash("ip", "10.0.0.1")).toBe(keyedHash("ip", "10.0.0.1"));
    expect(keyedHash("ip", "10.0.0.1")).not.toBe(keyedHash("rate-limit", "10.0.0.1"));
    expect(keyedHash("ip", "10.0.0.1")).not.toContain("10.0.0.1");
  });
});
