import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { sha256Hex } from "@/server/security/crypto";

/**
 * İmzalı belge PDF'i.
 *
 * PDF içeriği: klinik unvanı, şube, hasta adı, dosya no, belge tipi, versiyon, belge metni, seçimler,
 * hasta/yasal temsilci adı, statik imza, imza tarih-saati, belge ID ve İÇERİK ÖZETİ (SHA-256).
 *
 * İki özet vardır:
 *  - contentSha256 (PDF'in İÇİNDE yazılı): kanonik kanıt paketinin özeti — metin + seçimler + adlar + imza
 *    görüntüsünün özeti + zaman. Bir PDF kendi özetini içeremeyeceği için PDF'e bu yazılır.
 *  - patient_documents.document_sha256 (VERİTABANINDA): üretilen PDF dosyasının baytlarının SHA-256'sı.
 *    Saklanan PDF'in sonradan değiştirilmediği bu değerle doğrulanır.
 *
 * Türkçe karakterler için Inter (SIL OFL) gömülür (assets/fonts). Tarih/saat Europe/Istanbul gösterilir.
 */
export type SignedDocumentEvidence = {
  documentId: string;
  clinicName: string;
  /** Klinik ticari unvanı (ClinicProfile.legalName) — varsa PDF başlığında gösterilir. */
  clinicLegalName?: string | null;
  branchName: string;
  /** Şube adresi (Branch.address). */
  branchAddress?: string | null;
  /** Klinik logosunun SHA-256 özeti (logo baytları kanıta değil PDF'e gömülür; özet içerik özetine girer). */
  logoSha256?: string | null;
  patientName: string;
  patientNumber: string;
  documentType: string;
  templateName: string;
  documentVersion: number;
  content: string;
  choices: { key: string; label: string; value: string }[];
  signedByName: string;
  guardianName: string | null;
  signedAtIso: string;
  timezone: string;
  signaturePngSha256: string;
};

const TYPE_LABELS: Record<string, string> = {
  KVKK_DISCLOSURE: "KVKK Aydınlatma Metni",
  EXPLICIT_CONSENT: "Açık Rıza Beyanı",
  TREATMENT_CONSENT: "Tedavi Onam Formu",
  OTHER: "Diğer Belge",
};

const VALUE_LABELS: Record<string, string> = {
  READ_AND_INFORMED: "Okudum, bilgilendirildim",
  GRANTED: "Onaylıyorum",
  DENIED: "Onaylamıyorum",
};

/** Kanonik (anahtar sırası sabit) JSON → SHA-256. Aynı kanıt her zaman aynı özeti verir. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function evidenceSha256(e: SignedDocumentEvidence): string {
  return sha256Hex(`kliniva-evidence-v1:${canonicalJson(e)}`);
}

let fontCache: Promise<{ regular: Buffer; bold: Buffer }> | undefined;
function loadFonts() {
  const dir = path.join(process.cwd(), "assets", "fonts");
  fontCache ??= Promise.all([
    readFile(path.join(dir, "Inter-Regular.ttf")),
    readFile(path.join(dir, "Inter-Bold.ttf")),
  ]).then(([regular, bold]) => ({ regular, bold }));
  return fontCache;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
      else {
        if (line) lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function renderSignedDocumentPdf(
  e: SignedDocumentEvidence,
  signaturePng: Buffer,
  opts: { logoPng?: Buffer | null } = {},
): Promise<Buffer> {
  const fonts = await loadFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const bold = await pdf.embedFont(fonts.bold, { subset: true });
  const signedAt = new Date(e.signedAtIso);
  // Deterministik meta veri: oluşturma tarihi = imza zamanı; üretici bilgisi sabit.
  pdf.setTitle(`${TYPE_LABELS[e.documentType] ?? e.documentType} — ${e.documentId}`);
  pdf.setProducer("Kliniva AI");
  pdf.setCreator("Kliniva AI");
  pdf.setCreationDate(signedAt);
  pdf.setModificationDate(signedAt);

  const A4: [number, number] = [595.28, 841.89];
  const margin = 50;
  const width = A4[0] - margin * 2;
  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - margin;
  const ink = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.38, 0.4, 0.45);

  const ensure = (h: number) => {
    if (y - h < margin) {
      page = pdf.addPage(A4);
      y = A4[1] - margin;
    }
  };
  const text = (
    t: string,
    opts: { size?: number; font?: PDFFont; color?: typeof ink; gap?: number } = {},
  ) => {
    const size = opts.size ?? 10;
    const font = opts.font ?? regular;
    for (const line of wrap(t, font, size, width)) {
      ensure(size + 4);
      page.drawText(line, { x: margin, y: y - size, size, font, color: opts.color ?? ink });
      y -= size + 4;
    }
    y -= opts.gap ?? 0;
  };

  const when = new Intl.DateTimeFormat("tr-TR", {
    timeZone: e.timezone,
    dateStyle: "long",
    timeStyle: "medium",
  }).format(signedAt);

  if (opts.logoPng) {
    // Logo (ClinicProfile.logoStorageKey → PNG): sağ üst köşe, en çok 120×48 pt.
    const logo = await pdf.embedPng(opts.logoPng);
    const s = Math.min(120 / logo.width, 48 / logo.height, 1);
    page.drawImage(logo, {
      x: A4[0] - margin - logo.width * s,
      y: y - logo.height * s,
      width: logo.width * s,
      height: logo.height * s,
    });
  }
  text(e.clinicName, { size: 16, font: bold });
  if (e.clinicLegalName && e.clinicLegalName !== e.clinicName)
    text(e.clinicLegalName, { size: 9, color: muted });
  text(`Şube: ${e.branchName}`, { color: muted, gap: e.branchAddress ? 0 : 8 });
  if (e.branchAddress) text(e.branchAddress, { size: 9, color: muted, gap: 8 });
  text(`${TYPE_LABELS[e.documentType] ?? e.documentType} — ${e.templateName}`, { size: 13, font: bold });
  text(`Belge versiyonu: v${e.documentVersion}    Belge ID: ${e.documentId}`, {
    size: 9,
    color: muted,
    gap: 10,
  });
  text(`Hasta: ${e.patientName}    Dosya No: ${e.patientNumber}`, { font: bold, gap: 10 });
  text(e.content, { size: 10, gap: 10 });

  if (e.choices.length) {
    text("Seçimler", { size: 11, font: bold });
    for (const c of e.choices) text(`• ${c.label}: ${VALUE_LABELS[c.value] ?? c.value}`);
    y -= 8;
  }

  text(`İmzalayan: ${e.signedByName}`, { font: bold });
  if (e.guardianName) text(`Yasal temsilci: ${e.guardianName}`, { font: bold });
  text(`İmza tarihi ve saati: ${when} (${e.timezone})`, { gap: 6 });

  const img = await pdf.embedPng(signaturePng);
  const scale = Math.min(220 / img.width, 90 / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  ensure(h + 30);
  page.drawImage(img, { x: margin, y: y - h, width: w, height: h });
  y -= h + 6;
  page.drawLine({ start: { x: margin, y }, end: { x: margin + 240, y }, thickness: 0.5, color: muted });
  y -= 18;

  text(`İçerik özeti (SHA-256): ${evidenceSha256(e)}`, { size: 8, color: muted });
  text(
    "Bu belge Kliniva AI tarafından elektronik ortamda üretilmiştir. İmza yalnızca statik görüntü olarak alınmış; " +
      "biyometrik veri (basınç, hız, zamanlama) toplanmamıştır.",
    { size: 8, color: muted },
  );

  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
