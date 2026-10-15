/**
 * E2E kullanıcı hazırlığı (yalnızca yerel test ortamı, seed demo kliniği):
 *  - "e2e-resepsiyon@<slug>.demo" RESEPSİYON kullanıcısı yoksa oluşturulur.
 *  - Bu kullanıcının ve demo doktorun ("doktor@<slug>.demo") parolası HER ÇALIŞTIRMADA yeni rastgele değere ayarlanır.
 * Parolalar diske / loga YAZILMAZ: yalnızca stdout'a JSON olarak verilir ve global setup bunu bellekte okur
 * (execSync, stdio: pipe). Demo doktor seed'de zaten "giriş için kullanılmayan" rastgele parolaya sahiptir.
 *
 * Çalıştırma (yalnızca global setup): npx tsx --conditions=react-server tests/e2e/support/prepare-e2e-users.ts
 */
import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });

async function main() {
  const { and, eq, isNull, sql } = await import("drizzle-orm");
  const { getMigrationDb, closeMigrationDb } = await import("@/server/db/migration-client");
  const schema = await import("@/server/db/schema");
  const { hashPassword } = await import("@/server/security/password");
  const slug = process.env.SEED_TENANT_SLUG ?? "demo-klinik";
  const db = getMigrationDb();
  const pw = () => `E2e-${randomBytes(18).toString("base64url")}-9a`;
  const out = {
    reception: { email: `e2e-resepsiyon@${slug}.demo`, password: pw() },
    doctor: { email: `doktor@${slug}.demo`, password: pw() },
  };
  await db.transaction(async (tx) => {
    const [t] = (await tx.execute<{ id: string }>(sql`select id from kliniva.tenants where slug = ${slug}`))
      .rows;
    if (!t) throw new Error("seed kliniği yok (npm run db:seed)");
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    const findUser = async (email: string) =>
      (
        await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(schema.users.tenantId, t.id), eq(schema.users.emailNormalized, email)))
      )[0];
    let rec = await findUser(out.reception.email);
    if (!rec) {
      [rec] = await tx
        .insert(schema.users)
        .values({
          tenantId: t.id,
          email: out.reception.email,
          emailNormalized: out.reception.email,
          passwordHash: await hashPassword(out.reception.password),
          firstName: "E2E",
          lastName: "Resepsiyon",
        })
        .returning({ id: schema.users.id });
      const [role] = await tx
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(and(isNull(schema.roles.tenantId), eq(schema.roles.key, "RECEPTION")));
      await tx
        .insert(schema.userRoles)
        .values({ tenantId: t.id, userId: rec!.id, roleId: role!.id, branchId: null });
    } else {
      await tx
        .update(schema.users)
        .set({
          passwordHash: await hashPassword(out.reception.password),
          passwordChangedAt: new Date(),
          active: true,
        })
        .where(and(eq(schema.users.tenantId, t.id), eq(schema.users.id, rec.id)));
    }
    const doc = await findUser(out.doctor.email);
    if (!doc) throw new Error("demo doktor yok (npm run db:seed)");
    await tx
      .update(schema.users)
      .set({ passwordHash: await hashPassword(out.doctor.password), passwordChangedAt: new Date() })
      .where(and(eq(schema.users.tenantId, t.id), eq(schema.users.id, doc.id)));
  });
  await closeMigrationDb();
  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => {
  // Hata mesajında sır yok (parola / bağlantı dizesi yazılmaz).
  process.stderr.write(`prepare-e2e-users: ${e instanceof Error ? e.message.split("\n")[0] : "hata"}\n`);
  process.exit(1);
});
