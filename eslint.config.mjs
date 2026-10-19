import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "react/no-danger": "error",
      "no-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    // Migration (şema sahibi) bağlantısı uygulama kodunda HİÇBİR yerde kullanılamaz.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/server/db/migration-client",
              message: "Migration/sahip bağlantısı uygulama kodunda yasak (yalnızca scripts/ ve tests/).",
            },
          ],
        },
      ],
    },
  },
  {
    // Ham DB istemcisi yalnızca altyapı katmanlarında. Kiracı verisine erişim tenantQuery() ile yapılır.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/server/db/**",
      "src/server/tenant/**",
      "src/server/auth/session.ts",
      "src/server/auth/context.ts",
      "src/server/auth/login.ts",
      "src/server/auth/guards.ts",
      "src/server/auth/rbac-sync.ts",
      "src/server/security/rate-limit.ts",
      "src/server/services/mfa.ts",
      // Platform (yazılım sahibi) katmanı: kiracı verisine dokunmaz; kiracı işlemleri oturum doğrulayan DB fonksiyonlarıyla.
      "src/server/platform/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/server/db/migration-client",
              message: "Migration/sahip bağlantısı uygulama kodunda yasak (yalnızca scripts/ ve tests/).",
            },
            {
              name: "@/server/db/client",
              message: "Ham DB erişimi yasak. Kiracı verisi için tenantQuery(ctx, ...) kullanın.",
            },
          ],
        },
      ],
    },
  },
  {
    // runInTenant yalnızca giriş akışı içindir (henüz AuthContext yokken).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/tenant/**", "src/server/auth/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportSpecifier[imported.name='runInTenant']",
          message: "runInTenant yalnızca auth katmanında kullanılır; tenantQuery(ctx, ...) kullanın.",
        },
      ],
    },
  },
  {
    // İstemci bileşenleri sunucu modüllerini import edemez (sır/DB sızıntısı).
    files: ["src/components/**/*.tsx"],
    ignores: ["src/components/forbidden.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/*", "@/server/**"],
              message: "İstemci bileşeni sunucu modülü import edemez.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
