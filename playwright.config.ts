import { defineConfig } from "@playwright/test";

/**
 * Uçtan uca (E2E) duman testleri. Tarayıcı indirmez: sistemde kurulu Microsoft Edge kullanılır (channel: msedge).
 * Üretim build'i (`npm run build`) üzerinde `next start` ile çalışır.
 */
const PORT = 3107;

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  timeout: 30_000,
  retries: 0,
  // Testler paylaşılan demo kiracısına yazar ve sonunda temizler → dosyalar sırayla (temizlik başka dosyanın
  // verisini test sürerken silmesin).
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "msedge",
    headless: true,
  },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
