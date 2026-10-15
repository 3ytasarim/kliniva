import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { sha256Hex } from "@/server/security/crypto";
import { documentTitleOf, SIGNER_TYPE_LABELS } from "@/lib/document-labels";

/**
 * İmzalı belge PDF'i — A4, modern klinik tasarımı, Türkçe karakter destekli (Inter, SIL OFL).
 *
 * Yerleşim kuralları (testlerle doğrulanır):
 *  - Her sayfada header (1. sayfada logo + klinik bilgileri; sonrakilerde kompakt) ve footer
 *    (Belge ID · versiyon · içerik SHA-256 kısa · "Sayfa X / Y" · "Kliniva AI ile oluşturuldu").
 *  - İçerik header ve footer bölgelerine ASLA taşmaz; uzun metin otomatik sayfalanır.
 *  - Rıza tablosu satırları ve imza bloğu sayfa arasında BÖLÜNMEZ.
 *  - Klinik logosu yoksa sade metin başlık (Kliniva logosu klinik logosu yerine KULLANILMAZ).
 *
 * İki özet: PDF'in içinde snapshot'ın içerik özeti (contentSha256) yazılıdır; veritabanında document_sha256 =
 * PDF baytlarının özeti (bir dosya kendi özetini içeremez). Çıktı deterministiktir (aynı kanıt → aynı bayt).
 */
export type ChoiceRow = { key: string; label: string; kind: "ACKNOWLEDGEMENT" | "CONSENT"; value: string };

export type SignedDocumentEvidence = {
  documentId: string;
  documentType: string;
  templateName: string;
  documentVersion: number;
  content: string;
  choices: ChoiceRow[] | { key: string; label: string; value: string }[];
  clinicName: string;
  clinicLegalName?: string | null;
  clinicPhone?: string | null;
  clinicWebsite?: string | null;
  branchName: string;
  branchAddress?: string | null;
  logoSha256?: string | null;
  patientName: string;
  patientNumber: string;
  signedByName: string;
  signerType?: "PATIENT" | "PARENT" | "LEGAL_GUARDIAN";
  guardianName?: string | null;
  guardianRelationship?: string | null;
  signedAtIso: string;
  timezone: string;
  signaturePngSha256: string;
  contentSha256?: string | null;
};

export type LayoutBox = {
  page: number;
  top: number;
  bottom: number;
  kind: "header" | "footer" | "content" | "signature";
  text?: string;
};

export type PdfLayout = {
  pageCount: number;
  pageHeight: number;
  /** İçeriğin inebileceği en alt y (footer bölgesinin üstü). */
  contentFloor: number;
  /** Her sayfada içeriğin başlayabileceği en üst y (header bölgesinin altı). */
  contentCeilings: number[];
  boxes: LayoutBox[];
  signatureBlock: { page: number; top: number; bottom: number };
  hasLogo: boolean;
};

export { documentTitleOf };

const VALUE_LABELS: Record<string, string> = {
  READ_AND_INFORMED: "Okudum, bilgilendirildim",
  GRANTED: "Onaylı",
  DENIED: "Reddedildi",
};
const SIGNER_LABELS = SIGNER_TYPE_LABELS;

/** Kanonik (anahtar sırası sabit) JSON. */
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

// ---------------------------------------------------------------- tasarım sabitleri
const A4: [number, number] = [595.28, 841.89];
const MARGIN_X = 48;
const CONTENT_W = A4[0] - MARGIN_X * 2;
const HEADER_FIRST_H = 112;
const HEADER_REST_H = 54;
const FOOTER_H = 58;
const CONTENT_FLOOR = FOOTER_H + 16;

const C = {
  ink: rgb(0.09, 0.11, 0.15),
  body: rgb(0.2, 0.23, 0.28),
  muted: rgb(0.42, 0.45, 0.5),
  line: rgb(0.87, 0.89, 0.92),
  brand: rgb(0.06, 0.45, 0.41),
  brandSoft: rgb(0.93, 0.97, 0.96),
  card: rgb(0.97, 0.98, 0.98),
  ok: rgb(0.02, 0.47, 0.34),
  no: rgb(0.7, 0.16, 0.16),
};

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      // Çok uzun tek kelime (URL vb.) satıra sığmıyorsa karakter bazında bölünür → taşma yok.
      const pieces: string[] = [];
      let w = word;
      while (font.widthOfTextAtSize(w, size) > maxWidth && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxWidth) cut--;
        pieces.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      pieces.push(w);
      for (const piece of pieces) {
        const candidate = line ? `${line} ${piece}` : piece;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
        else {
          if (line) lines.push(line);
          line = piece;
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function renderSignedDocumentPdfWithLayout(
  e: SignedDocumentEvidence,
  signaturePng: Buffer,
  opts: { logoPng?: Buffer | null } = {},
): Promise<{ pdf: Buffer; layout: PdfLayout }> {
  const fonts = await loadFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const bold = await pdf.embedFont(fonts.bold, { subset: true });
  const signedAt = new Date(e.signedAtIso);
  const title = documentTitleOf(e.documentType);
  pdf.setTitle(`${title} — ${e.documentId}`);
  pdf.setProducer("Kliniva AI");
  pdf.setCreator("Kliniva AI");
  pdf.setCreationDate(signedAt);
  pdf.setModificationDate(signedAt);

  const logo: PDFImage | null = opts.logoPng ? await pdf.embedPng(opts.logoPng) : null;
  const boxes: LayoutBox[] = [];
  const ceilings: number[] = [];
  const when = new Intl.DateTimeFormat("tr-TR", {
    timeZone: e.timezone,
    dateStyle: "long",
    timeStyle: "short",
  }).format(signedAt);
  const dateOnly = new Intl.DateTimeFormat("tr-TR", { timeZone: e.timezone, dateStyle: "long" }).format(
    signedAt,
  );

  let page!: PDFPage;
  let y = 0;
  const pageIndex = () => pdf.getPageCount() - 1;

  const newPage = () => {
    page = pdf.addPage(A4);
    const first = pdf.getPageCount() === 1;
    y = A4[1] - (first ? HEADER_FIRST_H : HEADER_REST_H) - 18;
    ceilings.push(y);
  };
  const ensure = (h: number) => {
    if (y - h < CONTENT_FLOOR) newPage();
  };
  const draw = (
    t: string,
    x: number,
    yy: number,
    size: number,
    font: PDFFont,
    color: RGB,
    kind: LayoutBox["kind"] = "content",
    p: PDFPage = page,
    pageNo = pageIndex(),
  ) => {
    p.drawText(t, { x, y: yy, size, font, color });
    boxes.push({ page: pageNo, top: yy + size, bottom: yy - size * 0.25, kind, text: t });
  };
  const paragraph = (
    text: string,
    opt: { size?: number; font?: PDFFont; color?: RGB; gap?: number; lineGap?: number } = {},
  ) => {
    const size = opt.size ?? 10.5;
    const font = opt.font ?? regular;
    const lh = size + (opt.lineGap ?? 5);
    for (const line of wrap(text, font, size, CONTENT_W)) {
      ensure(lh);
      if (line) draw(line, MARGIN_X, y - size, size, font, opt.color ?? C.body);
      y -= lh;
    }
    y -= opt.gap ?? 0;
  };

  // ---------------------------------------------------------------- 1. sayfa: başlık + hasta kartı
  newPage();
  draw(title, MARGIN_X, y - 20, 20, bold, C.ink);
  y -= 30;
  draw(`${e.templateName} · Versiyon ${e.documentVersion}`, MARGIN_X, y - 10, 10, regular, C.muted);
  y -= 26;

  const cardRows: [string, string][] = [
    ["Hasta Adı Soyadı", e.patientName],
    ["Hasta No", e.patientNumber],
    ["Belge Tarihi", dateOnly],
    ["Belge Versiyonu", `v${e.documentVersion}`],
  ];
  const cardH = 2 * 34 + 20;
  ensure(cardH + 12);
  page.drawRectangle({
    x: MARGIN_X,
    y: y - cardH,
    width: CONTENT_W,
    height: cardH,
    color: C.card,
    borderColor: C.line,
    borderWidth: 0.8,
  });
  cardRows.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MARGIN_X + 16 + col * (CONTENT_W / 2);
    const top = y - 14 - row * 34;
    draw(label.toLocaleUpperCase("tr-TR"), x, top - 8, 7.5, bold, C.muted);
    const v = wrap(value, bold, 11, CONTENT_W / 2 - 28)[0] ?? "";
    draw(v, x, top - 22, 11, bold, C.ink);
  });
  y -= cardH + 22;

  // ---------------------------------------------------------------- belge metni
  paragraph(e.content, { size: 10.5, lineGap: 6, gap: 12 });

  // ---------------------------------------------------------------- seçimler / rıza tablosu
  if (e.choices.length) {
    const isConsent = e.choices.some((c) => c.value !== "READ_AND_INFORMED");
    ensure(40);
    draw(isConsent ? "Açık rıza tercihleri" : "Beyan", MARGIN_X, y - 12, 12, bold, C.ink);
    y -= 24;
    const statusW = 130;
    const labelW = CONTENT_W - statusW - 24;
    const headerRow = () => {
      page.drawRectangle({ x: MARGIN_X, y: y - 22, width: CONTENT_W, height: 22, color: C.brandSoft });
      draw("Tercih", MARGIN_X + 10, y - 15, 8.5, bold, C.brand);
      draw("Durum", MARGIN_X + CONTENT_W - statusW, y - 15, 8.5, bold, C.brand);
      y -= 22;
    };
    ensure(22 + 26);
    headerRow();
    for (const c of e.choices) {
      const lines = wrap(c.label, regular, 10, labelW);
      const rowH = Math.max(26, lines.length * 14 + 12);
      if (y - rowH < CONTENT_FLOOR) {
        newPage();
        headerRow();
      }
      page.drawLine({
        start: { x: MARGIN_X, y: y - rowH },
        end: { x: MARGIN_X + CONTENT_W, y: y - rowH },
        thickness: 0.6,
        color: C.line,
      });
      lines.forEach((l, i) => draw(l, MARGIN_X + 10, y - 16 - i * 14, 10, regular, C.body));
      const label = VALUE_LABELS[c.value] ?? c.value;
      const color = c.value === "DENIED" ? C.no : c.value === "GRANTED" ? C.ok : C.ink;
      draw(label, MARGIN_X + CONTENT_W - statusW, y - 16, 10, bold, color);
      y -= rowH;
    }
    y -= 16;
  }

  // ---------------------------------------------------------------- imza bloğu (bölünmez)
  const SIG_BLOCK_H = 196;
  ensure(SIG_BLOCK_H);
  const sigTop = y;
  const sigPage = pageIndex();
  page.drawRectangle({
    x: MARGIN_X,
    y: y - SIG_BLOCK_H,
    width: CONTENT_W,
    height: SIG_BLOCK_H,
    borderColor: C.line,
    borderWidth: 0.8,
  });
  draw("Hasta / Yasal Temsilci", MARGIN_X + 16, y - 22, 11, bold, C.ink, "signature");
  draw(
    "Bu imza, yukarıda görüntülenen belgenin bu sürümüne aittir.",
    MARGIN_X + 16,
    y - 38,
    8.5,
    regular,
    C.muted,
    "signature",
  );
  const leftX = MARGIN_X + 16;
  const rightX = MARGIN_X + CONTENT_W / 2 + 8;
  const signer = SIGNER_LABELS[e.signerType ?? "PATIENT"] ?? "Hasta";
  const fields: [string, string][] = [
    ["Ad Soyad", e.signedByName],
    ["İmzalayan", e.guardianRelationship ? `${signer} (${e.guardianRelationship})` : signer],
    ["Tarih / Saat", `${when} (${e.timezone})`],
  ];
  fields.forEach(([k, v], i) => {
    draw(k.toLocaleUpperCase("tr-TR"), leftX, y - 62 - i * 34, 7.5, bold, C.muted, "signature");
    const value = wrap(v, regular, 10, CONTENT_W / 2 - 32)[0] ?? "";
    draw(value, leftX, y - 76 - i * 34, 10, regular, C.ink, "signature");
  });
  draw("İMZA", rightX, y - 62, 7.5, bold, C.muted, "signature");
  const sig = await pdf.embedPng(signaturePng);
  const boxW = CONTENT_W / 2 - 24;
  const boxH = 100;
  const s = Math.min(boxW / sig.width, boxH / sig.height, 1);
  page.drawImage(sig, {
    x: rightX + (boxW - sig.width * s) / 2,
    y: y - 72 - boxH + (boxH - sig.height * s) / 2,
    width: sig.width * s,
    height: sig.height * s,
  });
  page.drawLine({
    start: { x: rightX, y: y - 76 - boxH },
    end: { x: rightX + boxW, y: y - 76 - boxH },
    thickness: 0.6,
    color: C.muted,
  });
  boxes.push({
    page: sigPage,
    top: sigTop,
    bottom: sigTop - SIG_BLOCK_H,
    kind: "signature",
    text: "[signature-block]",
  });
  y -= SIG_BLOCK_H + 12;

  paragraph(
    "Bu belge elektronik ortamda üretilmiştir. İmza yalnızca statik görüntü olarak alınmıştır; basınç, hız veya zamanlama gibi biyometrik veri toplanmamıştır.",
    { size: 7.5, color: C.muted, lineGap: 3 },
  );

  // ---------------------------------------------------------------- tüm sayfalara header + footer
  const total = pdf.getPageCount();
  const shortSha = (e.contentSha256 ?? evidenceSha256(e)).slice(0, 16);
  pdf.getPages().forEach((p, i) => {
    const top = A4[1] - 36;
    if (i === 0) {
      let textX = MARGIN_X;
      if (logo) {
        const ls = Math.min(140 / logo.width, 56 / logo.height, 1);
        p.drawImage(logo, {
          x: MARGIN_X,
          y: top - logo.height * ls,
          width: logo.width * ls,
          height: logo.height * ls,
        });
        textX = MARGIN_X + logo.width * ls + 16;
      }
      const maxW = A4[0] - MARGIN_X - textX;
      draw(wrap(e.clinicName, bold, 15, maxW)[0] ?? "", textX, top - 14, 15, bold, C.ink, "header", p, i);
      let ly = top - 30;
      const lines = [
        e.clinicLegalName && e.clinicLegalName !== e.clinicName ? e.clinicLegalName : null,
        [e.branchName, e.branchAddress].filter(Boolean).join(" · "),
        [e.clinicPhone, e.clinicWebsite].filter(Boolean).join(" · ") || null,
      ].filter((l): l is string => Boolean(l));
      for (const l of lines) {
        draw(wrap(l, regular, 8.5, maxW)[0] ?? "", textX, ly - 8.5, 8.5, regular, C.muted, "header", p, i);
        ly -= 13;
      }
      p.drawLine({
        start: { x: MARGIN_X, y: A4[1] - HEADER_FIRST_H + 6 },
        end: { x: A4[0] - MARGIN_X, y: A4[1] - HEADER_FIRST_H + 6 },
        thickness: 1,
        color: C.brand,
      });
    } else {
      draw(
        wrap(e.clinicName, bold, 10, CONTENT_W / 2)[0] ?? "",
        MARGIN_X,
        top - 10,
        10,
        bold,
        C.ink,
        "header",
        p,
        i,
      );
      const right = `${title} · v${e.documentVersion}`;
      draw(
        right,
        A4[0] - MARGIN_X - regular.widthOfTextAtSize(right, 8.5),
        top - 10,
        8.5,
        regular,
        C.muted,
        "header",
        p,
        i,
      );
      p.drawLine({
        start: { x: MARGIN_X, y: A4[1] - HEADER_REST_H + 6 },
        end: { x: A4[0] - MARGIN_X, y: A4[1] - HEADER_REST_H + 6 },
        thickness: 0.6,
        color: C.line,
      });
    }
    // footer
    p.drawLine({
      start: { x: MARGIN_X, y: FOOTER_H },
      end: { x: A4[0] - MARGIN_X, y: FOOTER_H },
      thickness: 0.6,
      color: C.line,
    });
    const left = `Belge ID: ${e.documentId} · v${e.documentVersion} · SHA-256: ${shortSha}…`;
    draw(left, MARGIN_X, FOOTER_H - 16, 7, regular, C.muted, "footer", p, i);
    const pageText = `Sayfa ${i + 1} / ${total}`;
    draw(
      pageText,
      A4[0] - MARGIN_X - regular.widthOfTextAtSize(pageText, 8),
      FOOTER_H - 16,
      8,
      bold,
      C.body,
      "footer",
      p,
      i,
    );
    draw("Kliniva AI ile oluşturuldu", MARGIN_X, FOOTER_H - 30, 6.5, regular, C.muted, "footer", p, i);
  });

  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  return {
    pdf: bytes,
    layout: {
      pageCount: total,
      pageHeight: A4[1],
      contentFloor: CONTENT_FLOOR,
      contentCeilings: ceilings,
      boxes,
      signatureBlock: { page: sigPage, top: sigTop, bottom: sigTop - SIG_BLOCK_H },
      hasLogo: Boolean(logo),
    },
  };
}

export async function renderSignedDocumentPdf(
  e: SignedDocumentEvidence,
  signaturePng: Buffer,
  opts: { logoPng?: Buffer | null } = {},
): Promise<Buffer> {
  return (await renderSignedDocumentPdfWithLayout(e, signaturePng, opts)).pdf;
}
