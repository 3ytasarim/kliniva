import "server-only";
import sharp, { type Metadata } from "sharp";

/**
 * Klinik logosu doğrulama + yeniden kodlama.
 *
 *  1. Boyut ≤ 5 MB (decode'dan ÖNCE).
 *  2. Magic bytes: yalnızca PNG / JPEG / WEBP. SVG (XML/script riski), GIF, BMP, TIFF, HEIC vb. reddedilir.
 *     Dosya adı / uzantı / istemcinin bildirdiği MIME tipi KARAR VERMEZ.
 *  3. Gerçek decode (sharp/libvips): bozuk veya sahte dosya → reddedilir. İçerik formatı magic bytes ile aynı olmalı.
 *  4. Piksel bombası koruması (limitInputPixels) + makul boyut sınırı.
 *  5. Çıktı: EXIF yönü uygulanmış, en çok 1024 px, METADATA'SIZ (EXIF/GPS/ICC yorumları atılır) PNG.
 *     PNG seçimi: imzalı PDF üreticisi (pdf-lib) PNG'yi doğrudan gömebilir.
 */
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const OUTPUT_MAX_SIDE = 1024;

export type LogoFormat = "png" | "jpeg" | "webp";

export class InvalidLogoError extends Error {
  constructor(
    readonly reason: "TOO_LARGE" | "EMPTY" | "UNSUPPORTED_TYPE" | "DECODE_FAILED" | "MISMATCH" | "DIMENSIONS",
  ) {
    super(`invalid logo: ${reason}`);
    this.name = "InvalidLogoError";
  }
}

/** Dosyanın İÇERİĞİNE bakarak formatı belirler (uzantıya değil). */
export function sniffImageFormat(buf: Buffer): LogoFormat | null {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length >= 12 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

export async function processLogo(
  input: Buffer,
): Promise<{ png: Buffer; width: number; height: number; sourceFormat: LogoFormat }> {
  if (input.length === 0) throw new InvalidLogoError("EMPTY");
  if (input.length > LOGO_MAX_BYTES) throw new InvalidLogoError("TOO_LARGE");
  const sniffed = sniffImageFormat(input);
  if (!sniffed) throw new InvalidLogoError("UNSUPPORTED_TYPE");

  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).metadata();
  } catch {
    throw new InvalidLogoError("DECODE_FAILED");
  }
  if (meta.format !== sniffed) throw new InvalidLogoError("MISMATCH");
  if (!meta.width || !meta.height || meta.width < 16 || meta.height < 16)
    throw new InvalidLogoError("DIMENSIONS");

  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate() // EXIF yönünü piksellere uygula (EXIF'in kendisi çıktıya YAZILMAZ)
      .resize({ width: OUTPUT_MAX_SIDE, height: OUTPUT_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height, sourceFormat: sniffed };
  } catch {
    throw new InvalidLogoError("DECODE_FAILED");
  }
}
