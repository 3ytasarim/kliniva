import { describe, expect, it } from "vitest";
import {
  decodeSignatureDataUrl,
  InvalidSignatureError,
  sanitizeSignaturePng,
} from "@/server/documents/signature";
import {
  canonicalJson,
  evidenceSha256,
  renderSignedDocumentPdf,
  type SignedDocumentEvidence,
} from "@/server/documents/pdf";
import { templateVersionSchema, validateChoices } from "@/server/services/documents";
import { AppError } from "@/server/errors";
import { makePng, pngDataUrl } from "../support/png";

describe("Statik imza PNG temizleme", () => {
  it("meta veri parçaları (tEXt/iTXt/eXIf) atılır, görüntü korunur", async () => {
    const evil = makePng(300, 100, [
      { type: "tEXt", data: Buffer.from("pressure\u0000[0.2,0.5,0.9] timings [12,15,40]") },
      { type: "iTXt", data: Buffer.from("biometric\u0000\u0000\u0000\u0000\u0000vector") },
      { type: "eXIf", data: Buffer.from("exif") },
    ]);
    const { png, width, height } = await sanitizeSignaturePng(evil);
    expect(width).toBe(300);
    expect(height).toBe(100);
    const s = png.toString("latin1");
    expect(s).not.toContain("tEXt");
    expect(s).not.toContain("pressure");
    expect(s).not.toContain("iTXt");
    expect(s).not.toContain("eXIf");
    expect(s).toContain("IHDR");
    expect(s).toContain("IDAT");
  });

  it("PNG olmayan veri reddedilir", async () => {
    await expect(sanitizeSignaturePng(Buffer.from("GIF89a....."))).rejects.toThrow(InvalidSignatureError);
  });

  it("aşırı boyutlar reddedilir", async () => {
    await expect(sanitizeSignaturePng(makePng(5000, 100))).rejects.toThrow(InvalidSignatureError);
    await expect(sanitizeSignaturePng(makePng(10, 10))).rejects.toThrow(InvalidSignatureError);
  });

  it("yalnızca data:image/png kabul edilir", () => {
    expect(decodeSignatureDataUrl(pngDataUrl(makePng())).subarray(1, 4).toString()).toBe("PNG");
    expect(() => decodeSignatureDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toThrow(InvalidSignatureError);
  });
});

describe("KVKK: aydınlatma ≠ açık rıza", () => {
  const disclosure = [
    { key: "read_and_informed", label: "Okudum", kind: "ACKNOWLEDGEMENT" as const, required: true },
  ];
  const consent = [{ key: "sms", label: "SMS", kind: "CONSENT" as const, required: true }];

  it("aydınlatma seçimi yalnızca READ_AND_INFORMED olabilir (GRANTED kaydedilemez)", () => {
    expect(validateChoices(disclosure, { read_and_informed: "READ_AND_INFORMED" })).toHaveLength(1);
    expect(() => validateChoices(disclosure, { read_and_informed: "GRANTED" })).toThrow(AppError);
  });

  it("rıza seçimi READ_AND_INFORMED olamaz; GRANTED/DENIED olur", () => {
    expect(() => validateChoices(consent, { sms: "READ_AND_INFORMED" })).toThrow(AppError);
    expect(validateChoices(consent, { sms: "DENIED" })[0]!.value).toBe("DENIED");
  });

  it("zorunlu seçim eksikse veya bilinmeyen anahtar varsa reddedilir", () => {
    expect(() => validateChoices(consent, {})).toThrow(AppError);
    expect(() => validateChoices(consent, { sms: "GRANTED", hidden_extra: "GRANTED" })).toThrow(AppError);
  });

  it("aydınlatma şablonu rıza seçimi içeremez", () => {
    const r = templateVersionSchema.safeParse({
      type: "KVKK_DISCLOSURE",
      name: "Aydınlatma",
      content: "Bu bir aydınlatma metnidir ve yeterince uzundur.",
      choices: [{ key: "marketing", label: "Pazarlama", kind: "CONSENT", required: false }],
    });
    expect(r.success).toBe(false);
  });
});

describe("İmzalı PDF", () => {
  const evidence: SignedDocumentEvidence = {
    documentId: "6f1c1b7e-1111-4a1a-9a1a-111111111111",
    clinicName: "Örnek Ağız ve Diş Sağlığı Polikliniği",
    branchName: "Şişli Şubesi",
    patientName: "Ayşe Yılmaz",
    patientNumber: "P-000042",
    documentType: "KVKK_DISCLOSURE",
    templateName: "Hasta Aydınlatma Metni",
    documentVersion: 3,
    content:
      "Kişisel verileriniz 6698 sayılı KVKK kapsamında işlenmektedir.\n\nİkinci paragraf: ğüşıöçİĞÜŞÖÇ.",
    choices: [{ key: "read_and_informed", label: "Okudum, bilgilendirildim", value: "READ_AND_INFORMED" }],
    signedByName: "Ayşe Yılmaz",
    guardianName: null,
    signedAtIso: "2026-10-14T09:30:00.000Z",
    timezone: "Europe/Istanbul",
    signaturePngSha256: "a".repeat(64),
  };

  it("Türkçe karakterlerle geçerli PDF üretir", async () => {
    const pdf = await renderSignedDocumentPdf(evidence, makePng(300, 100));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2000);
  });

  it("aynı kanıt aynı PDF'i üretir (deterministik → SHA-256 doğrulanabilir)", async () => {
    const png = makePng(300, 100);
    const a = await renderSignedDocumentPdf(evidence, png);
    const b = await renderSignedDocumentPdf(evidence, png);
    expect(a.equals(b)).toBe(true);
  });

  it("içerik özeti kanonik ve değişikliğe duyarlı", () => {
    expect(evidenceSha256(evidence)).toBe(evidenceSha256({ ...evidence }));
    expect(evidenceSha256({ ...evidence, documentVersion: 4 })).not.toBe(evidenceSha256(evidence));
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});
