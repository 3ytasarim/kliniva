/**
 * Geliştirme seed'i (idempotent). MEVCUT veritabanına yazar; yeni veritabanı oluşturmaz.
 *   1. RBAC kataloğu (yetkiler + sistem rolleri)
 *   2. Demo klinik + merkez şube + oda
 *   3. Klinik sahibi kullanıcı (SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD — .env.local, `npm run env:init`)
 *   4. KVKK aydınlatma metni v1 ve açık rıza beyanı v1 (yayımlanmış)
 * Parola ve diğer sırlar ekrana yazdırılmaz.
 */
import { loadEnvConfig } from "@next/env";
import { safeError } from "./lib/db-introspect";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });

async function main() {
  const { and, eq, isNull } = await import("drizzle-orm");
  // Seed migration (şema sahibi) bağlantısıyla çalışır: uygulama rolünün tenants/roles/permissions yazma yetkisi yoktur.
  const { getMigrationDb, closeMigrationDb } = await import("@/server/db/migration-client");
  const schema = await import("@/server/db/schema");
  const { syncRbacCatalog } = await import("@/server/auth/rbac-sync");
  const { runInTenantWith } = await import("@/server/tenant/tenant-query");
  const { hashPassword, passwordPolicy } = await import("@/server/security/password");
  const { normalizeEmail } = await import("@/server/validation");

  const slug = process.env.SEED_TENANT_SLUG ?? "demo-klinik";
  const email = process.env.SEED_OWNER_EMAIL;
  const password = process.env.SEED_OWNER_PASSWORD;
  if (!email || !password)
    throw new Error("SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD gerekli (npm run env:init)");
  passwordPolicy.parse(password);

  const db = getMigrationDb();
  await syncRbacCatalog(db);
  console.log("✓ RBAC kataloğu senkronize edildi");

  let [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug));
  if (!tenant) {
    [tenant] = await db.insert(schema.tenants).values({ name: "Demo Klinik", slug }).returning();
    console.log(`✓ Klinik oluşturuldu: ${slug}`);
  } else console.log(`• Klinik zaten var: ${slug}`);

  const [ownerRole] = await db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(and(isNull(schema.roles.tenantId), eq(schema.roles.key, "CLINIC_OWNER")));

  await runInTenantWith(db, tenant!.id, async (scope) => {
    const { tx, tenantId } = scope;
    const [profile] = await tx
      .select({ id: schema.clinicProfiles.id })
      .from(schema.clinicProfiles)
      .where(eq(schema.clinicProfiles.tenantId, tenantId));
    if (!profile) {
      await tx.insert(schema.clinicProfiles).values({ tenantId, displayName: "Demo Klinik" });
      console.log("✓ Klinik profili oluşturuldu");
    }
    let [branch] = await tx.select().from(schema.branches).where(eq(schema.branches.tenantId, tenantId));
    if (!branch) {
      [branch] = await tx
        .insert(schema.branches)
        .values({ tenantId, name: "Merkez Şube", city: "İstanbul" })
        .returning();
      await tx
        .insert(schema.rooms)
        .values({ tenantId, branchId: branch!.id, name: "Muayene 1", type: "EXAMINATION" });
      console.log("✓ Merkez şube + oda oluşturuldu");
    }

    const emailNormalized = normalizeEmail(email);
    const [existing] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.emailNormalized, emailNormalized)));
    if (!existing) {
      const [user] = await tx
        .insert(schema.users)
        .values({
          tenantId,
          email,
          emailNormalized,
          passwordHash: await hashPassword(password),
          firstName: "Klinik",
          lastName: "Sahibi",
        })
        .returning({ id: schema.users.id });
      await tx
        .insert(schema.userRoles)
        .values({ tenantId, userId: user!.id, roleId: ownerRole!.id, branchId: null });
      console.log("✓ Klinik sahibi kullanıcı oluşturuldu (parola .env.local'da)");
    } else console.log("• Klinik sahibi zaten var");

    const templates = [
      {
        type: "KVKK_DISCLOSURE" as const,
        name: "Hasta Aydınlatma Metni",
        content:
          "6698 sayılı Kişisel Verilerin Korunması Kanunu uyarınca, veri sorumlusu sıfatıyla kliniğimiz; kimlik, iletişim ve sağlık verilerinizi teşhis, tedavi ve sağlık hizmetlerinin yürütülmesi amaçlarıyla, Kanun'un 6. maddesinde belirtilen hukuki sebeplere dayanarak işlemektedir. [Bu metin şablondur; klinik hukuk danışmanınızca onaylanmalıdır.]",
        choices: [
          {
            key: "read_and_informed",
            label: "Aydınlatma metnini okudum ve bilgilendirildim.",
            kind: "ACKNOWLEDGEMENT" as const,
            required: true,
          },
        ],
      },
      {
        type: "EXPLICIT_CONSENT" as const,
        name: "Açık Rıza Beyanı",
        content:
          "Aşağıdaki işlemler için açık rızanızı, özgür iradenizle ve her biri için ayrı ayrı verebilir veya vermeyebilirsiniz. Rıza vermemeniz sağlık hizmeti almanıza engel değildir. [Bu metin şablondur; klinik hukuk danışmanınızca onaylanmalıdır.]",
        choices: [
          {
            key: "sms_reminders",
            label: "Randevu hatırlatmaları için SMS gönderilmesi",
            kind: "CONSENT" as const,
            required: true,
          },
          {
            key: "marketing",
            label: "Kampanya ve bilgilendirme iletileri gönderilmesi",
            kind: "CONSENT" as const,
            required: true,
          },
        ],
      },
    ];
    for (const t of templates) {
      const [exists] = await tx
        .select({ id: schema.documentTemplates.id })
        .from(schema.documentTemplates)
        .where(
          and(eq(schema.documentTemplates.tenantId, tenantId), eq(schema.documentTemplates.type, t.type)),
        );
      if (!exists) {
        await tx
          .insert(schema.documentTemplates)
          .values({ ...t, tenantId, version: 1, publishedAt: new Date() });
        console.log(`✓ Şablon yayımlandı: ${t.type} v1`);
      }
    }
  });

  // İdempotans özeti: iki kez çalıştırıldığında sayılar değişmemelidir.
  const { sql } = await import("drizzle-orm");
  const counts = await runInTenantWith(db, tenant!.id, async ({ tx }) => {
    const r = await tx.execute<Record<string, number>>(sql`
      select (select count(*)::int from kliniva.permissions) as permissions,
             (select count(*)::int from kliniva.roles where tenant_id is null) as system_roles,
             (select count(*)::int from kliniva.role_permissions) as role_permissions,
             (select count(*)::int from kliniva.tenants where slug = ${slug}) as seed_tenants,
             (select count(*)::int from kliniva.branches) as branches,
             (select count(*)::int from kliniva.clinic_profiles) as clinic_profiles,
             (select count(*)::int from kliniva.users) as users,
             (select count(*)::int from kliniva.user_roles) as user_roles,
             (select count(*)::int from kliniva.document_templates where tenant_id is not null) as templates,
             (select count(*)::int from kliniva.user_roles ur join kliniva.roles r on r.id = ur.role_id
                where r.key = 'PLATFORM_SUPER_ADMIN') as super_admin_in_tenant`);
    return r.rows[0]!;
  });
  console.log(
    `Sayımlar: ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" · ")}`,
  );
  if (counts.super_admin_in_tenant !== 0)
    throw new Error("KLINIVA_INVALID: PLATFORM_SUPER_ADMIN kiracıya atanmış");

  await closeMigrationDb();
}

main().catch((e: unknown) => {
  console.error(`seed başarısız: ${safeError(e)}`);
  process.exit(1);
});
