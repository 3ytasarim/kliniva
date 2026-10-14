import { existsSync } from "node:fs";

/**
 * Vitest NODE_ENV=test ayarlar; @next/env test modunda .env.local'ı bilerek YÜKLEMEZ. Entegrasyon ve bundle
 * testleri gerçek bağlantılara/sır değerlerine ihtiyaç duyduğu için .env.local açıkça okunur.
 * process.loadEnvFile mevcut ortam değişkenlerini EZMEZ; değerler hiçbir yere yazdırılmaz.
 */
export function loadEnvLocal() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
}
