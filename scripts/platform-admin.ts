/**
 * Platform yöneticisi hesabı oluşturma / parola yenileme (yalnızca sunucuda, migration bağlantısıyla).
 * Uygulama rolü platform yöneticisi EKLEYEMEZ; bu iş bilerek komut satırına bırakılmıştır.
 *
 *   PLATFORM_ADMIN_PASSWORD='...' npm run platform:admin -- --email sahip@ornek.com --name "Ad Soyad"
 *   PLATFORM_ADMIN_PASSWORD='...' npm run platform:admin -- --email sahip@ornek.com --reset-password
 *
 * Parola komut satırı argümanı olarak ALINMAZ (geçmişe / süreç listesine düşmesin); ortam değişkeninden okunur ve
 * hiçbir yere yazdırılmaz. İlk girişte iki adımlı doğrulama kurulumu zorunludur. --reset-password iki adımlı
 * doğrulamayı da sıfırlar (cihaz kaybı senaryosu).
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const { eq } = await import("drizzle-orm");
  const { getMigrationDb, closeMigrationDb } = await import("@/server/db/migration-client");
  const schema = await import("@/server/db/schema");
  const { hashPassword, passwordPolicy } = await import("@/server/security/password");
  const { normalizeEmail } = await import("@/server/validation");

  const email = arg("email");
  const name = arg("name");
  const reset = process.argv.includes("--reset-password");
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? "";
  if (!email) throw new Error("--email gerekli");
  const pw = passwordPolicy.safeParse(password);
  if (!pw.success) throw new Error(`PLATFORM_ADMIN_PASSWORD geçersiz: ${pw.error.issues[0]?.message}`);
  const emailNormalized = normalizeEmail(email);
  const db = getMigrationDb();
  const [existing] = await db
    .select({ id: schema.platformAdmins.id })
    .from(schema.platformAdmins)
    .where(eq(schema.platformAdmins.emailNormalized, emailNormalized));
  const passwordHash = await hashPassword(pw.data);
  if (existing) {
    if (!reset)
      throw new Error(
        "Bu e-postayla platform yöneticisi zaten var (parola yenilemek için --reset-password).",
      );
    await db
      .update(schema.platformAdmins)
      .set({
        passwordHash,
        twoFactorEnabled: false,
        twoFactorSecretEncrypted: null,
        twoFactorLastUsedStep: null,
        active: true,
        updatedAt: new Date(),
      })
      .where(eq(schema.platformAdmins.id, existing.id));
    await db
      .update(schema.platformSessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.platformSessions.adminId, existing.id));
    await db
      .insert(schema.platformAuditLogs)
      .values({ adminId: existing.id, action: "ADMIN_PASSWORD_RESET_CLI" });
    console.log("✓ Parola yenilendi; iki adımlı doğrulama ilk girişte yeniden kurulacak.");
  } else {
    if (!name) throw new Error("--name gerekli");
    const [row] = await db
      .insert(schema.platformAdmins)
      .values({ email: email.trim(), emailNormalized, displayName: name.trim(), passwordHash })
      .returning({ id: schema.platformAdmins.id });
    await db.insert(schema.platformAuditLogs).values({ adminId: row!.id, action: "ADMIN_CREATED_CLI" });
    console.log(
      "✓ Platform yöneticisi oluşturuldu. /platform/login adresinden giriş yapın (iki adımlı doğrulama kurulacak).",
    );
  }
  await closeMigrationDb();
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
