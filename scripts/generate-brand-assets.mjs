/**
 * Marka görsellerini üretir (tek seferlik; çıktılar repoda, kaynak PNG'ler repoda DEĞİL).
 *
 *   node scripts/generate-brand-assets.mjs "<logo.png (yazılı)>" "<ikon.png (yalnızca işaret)>"
 *
 * Kaynaklar beyaz zeminli, alfa kanalsız PNG'lerdir. Dış beyaz zemin KENARLARDAN taşma doldurma (flood fill) ile
 * saydamlaştırılır: logonun içindeki beyaz figür / çizgiler zeminle bağlantılı değilse beyaz kalır. Kenar pikselleri
 * yumuşatılır. Ardından içeriğe kırpılır ve kullanım boyutlarında üretilir:
 *   public/brand/kliniva-logo.{png,webp}   giriş ekranı (yazılı logo)
 *   public/brand/kliniva-mark.{png,webp}   kenar menü / asistan (işaret)
 *   src/app/icon.png                       favicon (Next.js dosya kuralı; saydam)
 *   src/app/apple-icon.png                 iOS ana ekran (opak beyaz zemin — iOS saydamlığı desteklemez)
 *   src/app/favicon.ico                    16 / 32 / 48 (PNG gömülü ICO)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const [logoSrc, markSrc] = process.argv.slice(2);
if (!logoSrc || !markSrc) {
  console.error("kullanım: node scripts/generate-brand-assets.mjs <logo.png> <ikon.png>");
  process.exit(1);
}

const WHITE = 236; // bu değerin üstündeki min(r,g,b) "zemin beyazı" sayılır
const EDGE = 196; // zemine komşu, bu aralıktaki pikseller yumuşak kenar (kısmi alfa)

/** Dış beyaz zemini saydamlaştırır, içeriğe kırpar; RGBA sharp örneği döner. */
async function cutout(src) {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const minc = (i) => Math.min(data[i], data[i + 1], data[i + 2]);
  const bg = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const push = (x, y) => {
    const p = y * w + x;
    if (bg[p] || minc(p * 4) < WHITE) return;
    bg[p] = 1;
    queue[tail++] = p;
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const i = p * 4;
      if (bg[p]) {
        data[i + 3] = 0;
        continue;
      }
      // Zemine komşu açık renkli kenar pikseli → kısmi saydamlık (beyaz hale kalmasın)
      const nearBg =
        (x > 0 && bg[p - 1]) || (x < w - 1 && bg[p + 1]) || (y > 0 && bg[p - w]) || (y < h - 1 && bg[p + w]);
      const m = minc(i);
      if (nearBg && m >= EDGE) data[i + 3] = Math.round(((255 - m) / (255 - EDGE)) * 255);
      if (data[i + 3] > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.02);
  const left = Math.max(minX - pad, 0);
  const top = Math.max(minY - pad, 0);
  const width = Math.min(maxX + pad, w - 1) - left + 1;
  const height = Math.min(maxY + pad, h - 1) - top + 1;
  const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
  return { png, width, height };
}

/** Kare tuval ortasına yerleştirir (padding oranı ile). */
async function square(png, size, { padding = 0, background = { r: 0, g: 0, b: 0, alpha: 0 } } = {}) {
  const inner = Math.round(size * (1 - padding * 2));
  const fitted = await sharp(png)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: fitted, gravity: "center" }])
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

/** PNG gömülü ICO (Vista+ tüm tarayıcılarda desteklenir). */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(buf.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.buf)]);
}

mkdirSync("public/brand", { recursive: true });

const logo = await cutout(logoSrc);
const mark = await cutout(markSrc);

// Yazılı logo: giriş ekranında ~220 px genişlik → 2x / 3x için 640 px
const logoW = 640;
const logoPng = await sharp(logo.png).resize({ width: logoW }).png({ compressionLevel: 9 }).toBuffer();
writeFileSync("public/brand/kliniva-logo.png", logoPng);
writeFileSync(
  "public/brand/kliniva-logo.webp",
  await sharp(logo.png).resize({ width: logoW }).webp({ quality: 90 }).toBuffer(),
);
const logoMeta = await sharp(logoPng).metadata();

// İşaret: kenar menüde 36 px → 3x için 160 px (kare)
const markPng = await square(mark.png, 160);
writeFileSync("public/brand/kliniva-mark.png", markPng);
writeFileSync("public/brand/kliniva-mark.webp", await sharp(markPng).webp({ quality: 92 }).toBuffer());

// Favicon / uygulama simgeleri
writeFileSync("src/app/icon.png", await square(mark.png, 192, { padding: 0.04 }));
writeFileSync(
  "src/app/apple-icon.png",
  await sharp(
    await square(mark.png, 180, { padding: 0.12, background: { r: 255, g: 255, b: 255, alpha: 1 } }),
  )
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer(),
);
const icoSizes = [16, 32, 48];
writeFileSync(
  "src/app/favicon.ico",
  ico(
    await Promise.all(
      icoSizes.map(async (size) => ({ size, buf: await square(mark.png, size, { padding: 0.02 }) })),
    ),
  ),
);

const kb = (b) => `${Math.round(b.length / 1024)} KB`;
console.log(
  `logo ${logoMeta.width}x${logoMeta.height} ${kb(logoPng)} · mark 160x160 ${kb(markPng)} · icon/apple/ico üretildi`,
);
