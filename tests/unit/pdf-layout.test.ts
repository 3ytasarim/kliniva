import { describe, expect, it } from "vitest";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  renderSignedDocumentPdfWithLayout,
  type PdfLayout,
  type SignedDocumentEvidence,
} from "@/server/documents/pdf";
import { makePng } from "../support/png";

/**
 * PDF v2 — "dosya var" değil, İÇERİK ve YERLEŞİM doğrulanır: pdfjs ile metin çıkarılır, görüntüler sayılır,
 * yerleşim kutuları header/footer bölgelerine taşma ve imza bloğu bölünmesi için kontrol edilir.
 */
const base: SignedDocumentEvidence = {
  documentId: "6f1c1b7e-2222-4a1a-9a1a-222222222222",
  documentType: "EXPLICIT_CONSENT",
  templateName: "Açık Rıza Beyanı",
  documentVersion: 2,
  content: "Kişisel verileriniz 6698 sayılı KVKK kapsamında işlenmektedir. Çağrı, ğüşıöç İĞÜŞÖÇ.",
  choices: [
    { key: "MARKETING_SMS", label: "SMS ile kampanya ve bilgilendirme", kind: "CONSENT", value: "GRANTED" },
    {
      key: "MARKETING_EMAIL",
      label: "E-posta ile kampanya ve bilgilendirme",
      kind: "CONSENT",
      value: "DENIED",
    },
  ],
  clinicName: "Örnek Işık Ağız ve Diş Sağlığı Polikliniği",
  clinicLegalName: "Örnek Sağlık Hizmetleri A.Ş.",
  clinicPhone: "+90 212 555 00 00",
  clinicWebsite: "https://ornek-klinik.example",
  branchName: "Şişli Şubesi",
  branchAddress: "Halaskargazi Cd. No:1, Şişli / İstanbul",
  patientName: "Ayşe Gül Yılmaz",
  patientNumber: "KLI-000042",
  signedByName: "Ayşe Gül Yılmaz",
  signerType: "PATIENT",
  signedAtIso: "2026-10-14T09:30:00.000Z",
  timezone: "Europe/Istanbul",
  signaturePngSha256: "a".repeat(64),
  contentSha256: "b1c2d3e4f5a6b7c8".padEnd(64, "0"),
};

async function inspect(pdf: Buffer) {
  const doc = await getDocument({
    data: new Uint8Array(pdf),
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;
  const pages: { text: string; images: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ");
    const ops = await page.getOperatorList();
    const images = ops.fnArray.filter(
      (f) => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject,
    ).length;
    pages.push({ text, images });
  }
  await doc.destroy();
  return pages;
}

function assertNoOverlap(layout: PdfLayout) {
  for (const b of layout.boxes.filter((x) => x.kind === "content" || x.kind === "signature")) {
    // İçerik footer bölgesine inmez, header bölgesine çıkmaz.
    expect(b.bottom, `${b.text} (sayfa ${b.page})`).toBeGreaterThanOrEqual(layout.contentFloor - 0.01);
    expect(b.top, `${b.text} (sayfa ${b.page})`).toBeLessThanOrEqual(layout.contentCeilings[b.page]! + 18.01);
  }
}

describe("PDF v2 — içerik", () => {
  it("klinik, şube, hasta, numara, başlık, sürüm, imzalayan, tarih, belge ID ve Türkçe karakterler metinde", async () => {
    const { pdf, layout } = await renderSignedDocumentPdfWithLayout(base, makePng(320, 120));
    const pages = await inspect(pdf);
    const all = pages.map((p) => p.text).join(" ");
    for (const needle of [
      "Örnek Işık Ağız ve Diş Sağlığı Polikliniği",
      "Örnek Sağlık Hizmetleri A.Ş.",
      "Şişli Şubesi",
      "Ayşe Gül Yılmaz",
      "KLI-000042",
      "Açık Rıza Beyanı",
      "v2",
      "14 Ekim 2026",
      base.documentId,
      "ğüşıöç İĞÜŞÖÇ",
      "Onaylı",
      "Reddedildi",
      "Kliniva AI ile oluşturuldu",
      "SHA-256: b1c2d3e4f5a6b7c8",
    ]) {
      expect(all, needle).toContain(needle);
    }
    expect(layout.pageCount).toBe(pages.length);
    expect(pages[0]!.text).toContain(`Sayfa 1 / ${pages.length}`);
  });

  it("yasal temsilci imzasında temsilci ve yakınlık yazılır", async () => {
    const { pdf } = await renderSignedDocumentPdfWithLayout(
      {
        ...base,
        signerType: "PARENT",
        signedByName: "Mehmet Yılmaz",
        guardianName: "Mehmet Yılmaz",
        guardianRelationship: "Baba",
      },
      makePng(320, 120),
    );
    const all = (await inspect(pdf)).map((p) => p.text).join(" ");
    expect(all).toContain("Mehmet Yılmaz");
    expect(all).toContain("Baba");
    expect(all).toContain("Veli");
  });
});

describe("PDF v2 — yerleşim", () => {
  const longContent = Array.from(
    { length: 60 },
    (_, i) =>
      `${i + 1}. Paragraf: kişisel verilerin işlenmesi, aktarılması ve saklanması hakkında ayrıntılı açıklama ğüşıöç.`,
  ).join("\n\n");
  const manyChoices = Array.from({ length: 30 }, (_, i) => ({
    key: `CHOICE_${i}`,
    label: `Seçenek ${i + 1}: iletişim izni açıklaması`,
    kind: "CONSENT" as const,
    value: i % 2 ? "DENIED" : "GRANTED",
  }));

  it("uzun metin çok sayfaya bölünür; her sayfada header ve footer, 'Sayfa X / Y' doğru", async () => {
    const { pdf, layout } = await renderSignedDocumentPdfWithLayout(
      { ...base, content: longContent, choices: manyChoices },
      makePng(320, 120),
    );
    expect(layout.pageCount).toBeGreaterThan(2);
    const pages = await inspect(pdf);
    expect(pages).toHaveLength(layout.pageCount);
    pages.forEach((p, i) => {
      expect(p.text).toContain(`Sayfa ${i + 1} / ${pages.length}`);
      expect(p.text).toContain("Kliniva AI ile oluşturuldu");
      expect(p.text).toContain("Örnek Işık");
    });
    for (let i = 0; i < layout.pageCount; i++) {
      expect(layout.boxes.some((b) => b.page === i && b.kind === "header")).toBe(true);
      expect(layout.boxes.some((b) => b.page === i && b.kind === "footer")).toBe(true);
    }
  });

  it("içerik footer / header bölgesine taşmaz", async () => {
    const { layout } = await renderSignedDocumentPdfWithLayout(
      { ...base, content: longContent, choices: manyChoices },
      makePng(320, 120),
    );
    assertNoOverlap(layout);
  });

  it("imza bloğu sayfalar arasında bölünmez (farklı metin uzunluklarında)", async () => {
    for (let n = 1; n <= 40; n += 3) {
      const content = Array.from({ length: n }, (_, i) => `Satır ${i + 1}: açıklama metni ğüş.`).join("\n");
      const { layout } = await renderSignedDocumentPdfWithLayout({ ...base, content }, makePng(320, 120));
      const sig = layout.signatureBlock;
      expect(sig.bottom, `n=${n}`).toBeGreaterThanOrEqual(layout.contentFloor - 0.01);
      expect(sig.top, `n=${n}`).toBeLessThanOrEqual(layout.contentCeilings[sig.page]! + 18.01);
      const sigBoxes = layout.boxes.filter((b) => b.kind === "signature");
      expect(new Set(sigBoxes.map((b) => b.page)).size, `n=${n}`).toBe(1);
    }
  }, 60_000);
});

describe("PDF v2 — logo", () => {
  it("klinik logosu varsa ilk sayfada çizilir (imza + logo = 2 görüntü)", async () => {
    const { pdf, layout } = await renderSignedDocumentPdfWithLayout(base, makePng(320, 120), {
      logoPng: makePng(200, 80),
    });
    expect(layout.hasLogo).toBe(true);
    const pages = await inspect(pdf);
    expect(pages.reduce((a, p) => a + p.images, 0)).toBe(2);
  });

  it("logo yoksa metin başlık; başka (ör. Kliniva) logo görüntüsü eklenmez", async () => {
    const { pdf, layout } = await renderSignedDocumentPdfWithLayout(base, makePng(320, 120));
    expect(layout.hasLogo).toBe(false);
    const pages = await inspect(pdf);
    expect(pages.reduce((a, p) => a + p.images, 0)).toBe(1); // yalnızca imza
    const header = layout.boxes.filter((b) => b.page === 0 && b.kind === "header").map((b) => b.text);
    expect(header).toContain(base.clinicName);
    expect(header.join(" ")).not.toMatch(/Kliniva/);
  });
});
