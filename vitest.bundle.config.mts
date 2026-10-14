import { defineConfig } from "vitest/config";

/** Build sonrası: istemci paketinde sır/DB bilgisi olmadığını doğrular (npm run build sonrası çalışır). */
export default defineConfig({
  test: { environment: "node", include: ["tests/bundle/**/*.test.ts"] },
});
