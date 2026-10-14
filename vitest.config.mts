import path from "node:path";
import { defineConfig } from "vitest/config";

/** Birim testleri: veritabanı gerektirmez. */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/support/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["tests/support/unit-setup.ts"],
  },
});
