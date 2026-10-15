import path from "node:path";
import { defineConfig } from "vitest/config";

/** İsteğe bağlı gerçek OpenAI Realtime duman testi: OPENAI_API_KEY yoksa atlanır (CI varsayılanı). */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/support/server-only.ts"),
    },
  },
  test: { environment: "node", include: ["tests/voice/**/*.test.ts"], testTimeout: 30_000 },
});
