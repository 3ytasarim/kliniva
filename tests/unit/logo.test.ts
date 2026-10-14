import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { InvalidLogoError, LOGO_MAX_BYTES, processLogo, sniffImageFormat } from "@/server/media/logo";
import { makePng } from "../support/png";

const reason = async (buf: Buffer) => {
  try {
    await processLogo(buf);
    return "OK";
  } catch (e) {
    return e instanceof InvalidLogoError ? e.reason : `UNEXPECTED:${(e as Error).message}`;
  }
};

const solid = (format: "jpeg" | "webp" | "gif" | "tiff") =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 15, g: 115, b: 105 } } })
    .toFormat(format)
    .toBuffer();

describe("Klinik logosu doğrulama", () => {
  it("geçerli PNG / JPEG / WEBP kabul edilir ve PNG'ye yeniden kodlanır", async () => {
    for (const buf of [makePng(120, 60), await solid("jpeg"), await solid("webp")]) {
      const out = await processLogo(buf);
      expect(sniffImageFormat(out.png)).toBe("png");
      expect(out.width).toBeGreaterThan(0);
    }
  });

  it("SVG reddedilir (script/XSS riski)", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>',
    );
    expect(await reason(svg)).toBe("UNSUPPORTED_TYPE");
  });

  it("geçersiz MIME / desteklenmeyen format (GIF, TIFF, PDF, metin) reddedilir", async () => {
    expect(await reason(await solid("gif"))).toBe("UNSUPPORTED_TYPE");
    expect(await reason(await solid("tiff"))).toBe("UNSUPPORTED_TYPE");
    expect(await reason(Buffer.from("%PDF-1.7 ..."))).toBe("UNSUPPORTED_TYPE");
    expect(await reason(Buffer.from("logo.png aslında metin dosyası"))).toBe("UNSUPPORTED_TYPE");
  });

  it("sahte PNG (doğru imza, bozuk içerik) decode aşamasında reddedilir", async () => {
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("not really a png"),
    ]);
    expect(await reason(fake)).toBe("DECODE_FAILED");
  });

  it("5 MB sınırını aşan dosya decode edilmeden reddedilir", async () => {
    const big = Buffer.concat([makePng(100, 100), Buffer.alloc(LOGO_MAX_BYTES)]);
    expect(await reason(big)).toBe("TOO_LARGE");
  });

  it("çok küçük görsel reddedilir; boş dosya reddedilir", async () => {
    expect(await reason(makePng(50, 20).subarray(0, 0))).toBe("EMPTY");
    expect(await reason(makePng(10, 10))).toBe("DIMENSIONS");
  });

  it("EXIF / metadata çıktıya taşınmaz", async () => {
    const withExif = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "GIZLI-META-123", Artist: "Konum Bilgisi" } } })
      .toBuffer();
    expect(withExif.toString("latin1")).toContain("GIZLI-META-123");
    const out = await processLogo(withExif);
    expect(out.png.toString("latin1")).not.toContain("GIZLI-META-123");
    expect(out.png.toString("latin1")).not.toContain("Konum Bilgisi");
    const meta = await sharp(out.png).metadata();
    expect(meta.exif).toBeUndefined();
  });
});
