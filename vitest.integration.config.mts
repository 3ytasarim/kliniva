import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Entegrasyon testleri: MEVCUT Neon veritabanına (DATABASE_URL) bağlanır. Yeni veritabanı oluşturmaz.
 * Her test dosyası rastgele slug'lı test kiracıları oluşturur ve sonunda (retention purge ile) siler.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/support/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/support/integration-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
