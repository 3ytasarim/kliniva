/**
 * Geliştirme seed'i (idempotent). MEVCUT veritabanına yazar; yeni veritabanı oluşturmaz.
 *   1. RBAC kataloğu (yetkiler + sistem rolleri)
 *   2. Demo klinik + merkez şube + oda
 *   3. Klinik sahibi kullanıcı (SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD — .env.local, `npm run env:init`)
 *   4. KVKK aydınlatma metni ve açık rıza beyanı (yayımlanmış)
 *   5. Demo hizmetler + demo doktor (her gün 08:00–20:00) — randevu akışı için
 * Parola ve diğer sırlar ekrana yazdırılmaz.
 */
import { loadEnvConfig } from "@next/env";
import { safeError } from "./lib/db-introspect";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });

async function main() {
  const { and, desc, eq, isNull } = await import("drizzle-orm");
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

    const DRAFT_NOTE = "[Bu metin şablondur; klinik hukuk danışmanınızca onaylanmalıdır.]";
    const templates = [
      {
        type: "KVKK_DISCLOSURE" as const,
        name: "Hasta Aydınlatma Metni",
        content:
          "6698 sayılı Kişisel Verilerin Korunması Kanunu uyarınca, veri sorumlusu sıfatıyla kliniğimiz; kimlik, iletişim ve sağlık verilerinizi teşhis, tedavi ve sağlık hizmetlerinin yürütülmesi amaçlarıyla, Kanun'un 6. maddesinde belirtilen hukuki sebeplere dayanarak işlemektedir. " +
          DRAFT_NOTE,
        choices: [
          {
            key: "READ_AND_INFORMED",
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
          "Aşağıdaki iletişim kanalları için açık rızanızı, özgür iradenizle ve her biri için ayrı ayrı verebilir veya vermeyebilirsiniz. Rıza vermemeniz sağlık hizmeti almanıza engel değildir. Verdiğiniz rızayı dilediğiniz zaman geri çekebilirsiniz. " +
          DRAFT_NOTE,
        choices: [
          {
            key: "MARKETING_SMS",
            label: "SMS ile kampanya ve bilgilendirme",
            kind: "CONSENT" as const,
            required: true,
          },
          {
            key: "MARKETING_EMAIL",
            label: "E-posta ile kampanya ve bilgilendirme",
            kind: "CONSENT" as const,
            required: true,
          },
          { key: "MARKETING_PHONE", label: "Telefon ile arama", kind: "CONSENT" as const, required: true },
          { key: "MARKETING_WHATSAPP", label: "WhatsApp mesajı", kind: "CONSENT" as const, required: true },
        ],
      },
    ];
    // Yayımlanmış sürüm DEĞİŞTİRİLMEZ. Güncel sürümün seçim anahtarları beklenenden farklıysa (ör. Sprint 0 küçük harf
    // anahtarları) yeni sürüm eklenip yayımlanır; eşleşiyorsa hiçbir şey yapılmaz (idempotent).
    const keysOf = (choices: { key: string }[]) => choices.map((c) => c.key).join(",");
    for (const t of templates) {
      const rows = await tx
        .select({
          id: schema.documentTemplates.id,
          version: schema.documentTemplates.version,
          active: schema.documentTemplates.active,
          publishedAt: schema.documentTemplates.publishedAt,
          choices: schema.documentTemplates.choices,
        })
        .from(schema.documentTemplates)
        .where(
          and(eq(schema.documentTemplates.tenantId, tenantId), eq(schema.documentTemplates.type, t.type)),
        )
        .orderBy(desc(schema.documentTemplates.version));
      const live = rows.find((r) => r.active && r.publishedAt);
      if (live && keysOf(live.choices) === keysOf(t.choices)) continue;
      const version = (rows[0]?.version ?? 0) + 1;
      await tx
        .update(schema.documentTemplates)
        .set({ active: false })
        .where(
          and(eq(schema.documentTemplates.tenantId, tenantId), eq(schema.documentTemplates.type, t.type)),
        );
      await tx
        .insert(schema.documentTemplates)
        .values({ ...t, tenantId, version, active: true, publishedAt: new Date() });
      console.log(`✓ Şablon yayımlandı: ${t.type} v${version}`);
    }

    // Sprint 3 — demo hizmetler + demo doktor (randevu akışını denemek için). Parolası rastgele ve hiçbir yere
    // yazılmaz (bu hesapla giriş yapılmaz; yalnızca takvim/uygunluk verisi için). Her adım idempotenttir.
    const demoServices = [
      {
        name: "Muayene",
        code: "MUA",
        defaultDurationMinutes: 30,
        requiresRoom: true,
        allowedRoomTypes: ["EXAMINATION" as const],
      },
      {
        name: "PRP",
        code: "PRP",
        defaultDurationMinutes: 45,
        requiresRoom: true,
        allowedRoomTypes: ["PROCEDURE" as const],
      },
      {
        name: "Lazer",
        code: "LZR",
        defaultDurationMinutes: 60,
        requiresRoom: true,
        allowedRoomTypes: ["LASER" as const],
      },
      {
        name: "Danışma",
        code: "DAN",
        defaultDurationMinutes: 30,
        requiresRoom: false,
        allowedRoomTypes: null,
      },
    ];
    for (const s of demoServices) {
      const [found] = await tx
        .select({ id: schema.clinicalServices.id })
        .from(schema.clinicalServices)
        .where(and(eq(schema.clinicalServices.tenantId, tenantId), eq(schema.clinicalServices.name, s.name)));
      if (!found) {
        await tx.insert(schema.clinicalServices).values({ ...s, tenantId });
        console.log(`✓ Hizmet eklendi: ${s.name}`);
      }
    }
    const doctorEmail = normalizeEmail(`doktor@${slug}.demo`);
    let [docUser] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.emailNormalized, doctorEmail)));
    if (!docUser) {
      const { randomBytes } = await import("node:crypto");
      [docUser] = await tx
        .insert(schema.users)
        .values({
          tenantId,
          email: doctorEmail,
          emailNormalized: doctorEmail,
          passwordHash: await hashPassword(`${randomBytes(24).toString("base64url")}-Aa1!`),
          firstName: "Demo",
          lastName: "Doktor",
        })
        .returning({ id: schema.users.id });
      const [doctorRole] = await tx
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(and(isNull(schema.roles.tenantId), eq(schema.roles.key, "DOCTOR")));
      await tx
        .insert(schema.userRoles)
        .values({ tenantId, userId: docUser!.id, roleId: doctorRole!.id, branchId: null });
      console.log("✓ Demo doktor kullanıcısı oluşturuldu (giriş için kullanılmaz)");
    }
    let [docProfile] = await tx
      .select({ id: schema.doctorProfiles.id })
      .from(schema.doctorProfiles)
      .where(
        and(eq(schema.doctorProfiles.tenantId, tenantId), eq(schema.doctorProfiles.userId, docUser!.id)),
      );
    if (!docProfile) {
      [docProfile] = await tx
        .insert(schema.doctorProfiles)
        .values({ tenantId, userId: docUser!.id, title: "Dr.", specialty: "Genel" })
        .returning({ id: schema.doctorProfiles.id });
    }
    const [link] = await tx
      .select({ id: schema.doctorBranches.id })
      .from(schema.doctorBranches)
      .where(
        and(
          eq(schema.doctorBranches.doctorId, docProfile!.id),
          eq(schema.doctorBranches.branchId, branch!.id),
        ),
      );
    if (!link) {
      await tx
        .insert(schema.doctorBranches)
        .values({ tenantId, doctorId: docProfile!.id, branchId: branch!.id });
      for (let day = 1; day <= 7; day++) {
        await tx.insert(schema.doctorWorkingHours).values({
          tenantId,
          doctorId: docProfile!.id,
          branchId: branch!.id,
          dayOfWeek: day,
          startTime: "08:00",
          endTime: "20:00",
        });
      }
      console.log("✓ Demo doktor şubeye atandı (her gün 08:00–20:00)");
    }
    const services = await tx
      .select({ id: schema.clinicalServices.id })
      .from(schema.clinicalServices)
      .where(eq(schema.clinicalServices.tenantId, tenantId));
    for (const s of services) {
      await tx
        .insert(schema.doctorServices)
        .values({ tenantId, doctorId: docProfile!.id, serviceId: s.id })
        .onConflictDoNothing();
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
             (select count(*)::int from kliniva.clinical_services) as services,
             (select count(*)::int from kliniva.doctor_profiles) as doctors,
             (select count(*)::int from kliniva.doctor_services) as doctor_services,
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
