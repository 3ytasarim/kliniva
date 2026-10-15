import { describe, expect, it } from "vitest";
import { formatPhone, maskPhoneNumber, normalizeEmailAddress, normalizePhone } from "@/lib/phone";
import {
  computePrivacyStatus,
  createPatientSchema,
  isValidTurkishNationalId,
} from "@/server/services/patients";
import { revokeConsentSchema, signDocumentSchema, validateChoices } from "@/server/services/documents";
import {
  decodeSignatureDataUrl,
  InvalidSignatureError,
  sanitizeSignaturePng,
} from "@/server/documents/signature";
import { AppError } from "@/server/errors";
import { makePng, pngDataUrl } from "../support/png";

describe("Telefon / e-posta normalizasyonu", () => {
  it.each([
    ["0532 123 45 67", "+905321234567"],
    ["(0532) 123-45-67", "+905321234567"],
    ["5321234567", "+905321234567"],
    ["905321234567", "+905321234567"],
    ["+90 532 123 45 67", "+905321234567"],
    ["0090 532 123 45 67", "+905321234567"],
    ["+49 30 1234567", "+49301234567"],
  ])("%s → %s", (raw, e164) => {
    expect(normalizePhone(raw)).toBe(e164);
  });

  it("belirsiz / geçersiz numara null (tahmin yok)", () => {
    for (const raw of ["", "abc", "123", "0532 123", "+12", null, undefined])
      expect(normalizePhone(raw)).toBeNull();
  });

  it("ülke farkındalığı: Almanya ulusal biçimi", () => {
    expect(normalizePhone("030 12345678", "DE")).toBe("+493012345678");
    expect(normalizePhone("030 1234567", "DE")).toBe("+49301234567"); // değişken uzunluk
    expect(normalizePhone("030 1234567", "TR")).toBeNull(); // TR: 10 hane değil
    expect(normalizePhone("0532 123 45 67", "OTHER")).toBeNull(); // kural yok → tahmin yok
  });

  it("e-posta küçük harf + kırpma; maskeleme ve gösterim", () => {
    expect(normalizeEmailAddress("  Ayse.YILMAZ@Example.COM ")).toBe("ayse.yilmaz@example.com");
    expect(normalizeEmailAddress("   ")).toBeNull();
    expect(maskPhoneNumber("+905321234567")).toBe("********4567");
    expect(formatPhone("+905321234567")).toBe("+90 532 123 45 67");
  });
});

describe("Hasta doğrulama", () => {
  it("TC kimlik algoritması", () => {
    expect(isValidTurkishNationalId("10000000146")).toBe(true);
    expect(isValidTurkishNationalId("10000000147")).toBe(false);
    expect(isValidTurkishNationalId("01234567890")).toBe(false);
  });

  it("geçersiz TC kimlik ve geçersiz telefon reddedilir; branchId takma adı kabul edilir", () => {
    const base = { firstName: "Ayşe", lastName: "Yılmaz", phone: "05321234567" };
    expect(createPatientSchema.safeParse({ ...base, nationalId: "12345678901" }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...base, phone: "12" }).success).toBe(false);
    const id = "6f1c1b7e-1111-4a1a-9a1a-111111111111";
    const r = createPatientSchema.safeParse({ ...base, branchId: id });
    expect(r.success && r.data.primaryBranchId).toBe(id);
  });
});

describe("KVKK durumu (türetilmiş)", () => {
  const f = { disclosureSigned: false, consentDecided: false, pending: false, consentRequired: true };
  it("hiçbir şey yok → MISSING", () => expect(computePrivacyStatus(f)).toBe("MISSING"));
  it("bekleyen belge → PARTIAL", () => expect(computePrivacyStatus({ ...f, pending: true })).toBe("PARTIAL"));
  it("yalnızca aydınlatma → PARTIAL", () =>
    expect(computePrivacyStatus({ ...f, disclosureSigned: true })).toBe("PARTIAL"));
  it("aydınlatma + rıza kararı (DENIED dahil) → COMPLETE", () =>
    expect(computePrivacyStatus({ ...f, disclosureSigned: true, consentDecided: true })).toBe("COMPLETE"));
  it("rıza şablonu yoksa aydınlatma yeterli → COMPLETE", () =>
    expect(computePrivacyStatus({ ...f, disclosureSigned: true, consentRequired: false })).toBe("COMPLETE"));
});

describe("Aydınlatma ≠ rıza", () => {
  const disclosure = [
    { key: "READ_AND_INFORMED", label: "Okudum", kind: "ACKNOWLEDGEMENT" as const, required: true },
  ];
  const consent = ["MARKETING_SMS", "MARKETING_EMAIL", "MARKETING_PHONE", "MARKETING_WHATSAPP"].map(
    (key) => ({
      key,
      label: key,
      kind: "CONSENT" as const,
      required: true,
    }),
  );

  it("aydınlatma yalnızca READ_AND_INFORMED kabul eder", () => {
    expect(validateChoices(disclosure, { READ_AND_INFORMED: "READ_AND_INFORMED" })).toHaveLength(1);
    expect(() => validateChoices(disclosure, { READ_AND_INFORMED: "GRANTED" })).toThrow(AppError);
    expect(() => validateChoices(disclosure, { READ_AND_INFORMED: "DENIED" })).toThrow(AppError);
  });

  it("açık rıza her kanal için ayrı GRANTED / DENIED", () => {
    const r = validateChoices(consent, {
      MARKETING_SMS: "GRANTED",
      MARKETING_EMAIL: "DENIED",
      MARKETING_PHONE: "DENIED",
      MARKETING_WHATSAPP: "GRANTED",
    });
    expect(r.map((x) => x.value)).toEqual(["GRANTED", "DENIED", "DENIED", "GRANTED"]);
    expect(() => validateChoices(consent, { MARKETING_SMS: "GRANTED" })).toThrow(AppError);
  });

  it("geri çekme kanalı ve anahtar doğrulanır", () => {
    expect(revokeConsentSchema.safeParse({ key: "MARKETING_SMS", channel: "PHONE" }).success).toBe(true);
    expect(revokeConsentSchema.safeParse({ key: "MARKETING_SMS", channel: "PIGEON" }).success).toBe(false);
    expect(revokeConsentSchema.safeParse({ key: "x; drop", channel: "PHONE" }).success).toBe(false);
  });

  it("imza girdisi: imzalayan türü ve yasal temsilci yakınlığı", () => {
    const base = { signedByName: "Mehmet Yılmaz", signaturePng: pngDataUrl(makePng(300, 100)), choices: {} };
    expect(signDocumentSchema.safeParse({ ...base, signerType: "PATIENT" }).success).toBe(true);
    expect(signDocumentSchema.safeParse({ ...base, signerType: "PARENT" }).success).toBe(false);
    expect(
      signDocumentSchema.safeParse({ ...base, signerType: "PARENT", guardianRelationship: "Baba" }).success,
    ).toBe(true);
    expect(signDocumentSchema.safeParse({ ...base, signerType: "ROBOT" }).success).toBe(false);
  });
});

describe("Statik imza güvenliği", () => {
  it("SVG / JPEG data URL reddedilir", () => {
    expect(() => decodeSignatureDataUrl("data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+")).toThrow(
      InvalidSignatureError,
    );
    expect(() => decodeSignatureDataUrl("data:image/jpeg;base64,/9j/4AAQ")).toThrow(InvalidSignatureError);
  });

  it("PNG uzantılı sahte dosya (PNG imzası var, gövde bozuk) reddedilir", async () => {
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("<svg/>"),
    ]);
    await expect(sanitizeSignaturePng(fake)).rejects.toThrow(InvalidSignatureError);
  });

  it("boyut sınırı (300 KB) aşılırsa reddedilir", async () => {
    const big = makePng(400, 150, [{ type: "tEXt", data: Buffer.alloc(320 * 1024, 65) }]);
    await expect(sanitizeSignaturePng(big)).rejects.toThrow(InvalidSignatureError);
  });

  it("yeniden kodlanmış çıktı biyometrik/metin meta verisi taşımaz", async () => {
    const png = makePng(300, 100, [
      { type: "tEXt", data: Buffer.from("pressure\u0000[0.1,0.9]") },
      { type: "tIME", data: Buffer.alloc(7, 1) },
    ]);
    const out = await sanitizeSignaturePng(png);
    const s = out.png.toString("latin1");
    for (const marker of ["tEXt", "tIME", "pressure", "iTXt", "zTXt", "eXIf"])
      expect(s).not.toContain(marker);
  });
});
