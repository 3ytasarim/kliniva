import { defineConfig } from "@playwright/test";

/**
 * Uçtan uca (E2E) duman testleri. Tarayıcı indirmez: sistemde kurulu Microsoft Edge kullanılır (channel: msedge).
 * Üretim build'i (`npm run build`) üzerinde `next start` ile çalışır.
 */
const PORT = 3107;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: 0,
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
