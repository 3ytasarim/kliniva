import "server-only";
import { logger } from "@/server/log/logger";
import { processOutboxBatch } from "@/server/notifications/outbox";
import { scanExpiryNotifications } from "@/server/notifications/expiry-scan";

/**
 * Süreç içi arka plan işçisi (sunucu açılışında bir kez başlatılır):
 *  - outbox poller (varsayılan 5 sn): commit sonrası dürtmenin kaçırdığı, ileri tarihli (yeniden deneme) olaylar.
 *  - SKT taraması (varsayılan 60 dk).
 * Çoklu örnekte güvenlidir: işleme SKIP LOCKED + tekilleştirme ile idempotent. Çakışan çalıştırma engellenir.
 * OUTBOX_AUTOPROCESS=off ise başlamaz (testler işlemciyi açıkça çağırır).
 */
const g = globalThis as unknown as { __klinivaWorker?: boolean };

export function startNotificationWorker(): void {
  if (g.__klinivaWorker || process.env.OUTBOX_AUTOPROCESS === "off") return;
  g.__klinivaWorker = true;
  const pollMs = Math.max(Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 5_000), 1_000);
  const scanMs = Math.max(Number(process.env.EXPIRY_SCAN_INTERVAL_MS ?? 3_600_000), 60_000);
  let polling = false;
  let scanning = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      await processOutboxBatch();
    } catch (e) {
      logger.error("outbox.poll_failed", { error: e });
    } finally {
      polling = false;
    }
  };
  const scan = async () => {
    if (scanning) return;
    scanning = true;
    try {
      await scanExpiryNotifications();
    } catch (e) {
      logger.error("expiry_scan.failed", { error: e });
    } finally {
      scanning = false;
    }
  };
  setInterval(poll, pollMs).unref();
  setInterval(scan, scanMs).unref();
  // Açılışta bir kez (gecikmeli — sunucu hazır olduktan sonra).
  setTimeout(scan, 10_000).unref();
}
