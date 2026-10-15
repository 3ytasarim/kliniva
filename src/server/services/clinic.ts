import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { clinicProfiles, tenants } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import { actorOf, requirePermission, type AuthContext } from "@/server/auth/authz";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { getPrivateStorage, keyBelongsToTenant, newStorageKey } from "@/server/storage/private-storage";
import { InvalidLogoError, processLogo } from "@/server/media/logo";
import { isValidTimeZone } from "@/lib/time";
import { parseInput } from "@/server/services/parse";
import { emailSchema, phoneSchema } from "@/server/validation";

/**
 * Klinik profili + logo. Kiracı başına tek profil (tenant_id UNIQUE, RLS FORCE).
 * Logo yalnızca oturumdaki kiracı için okunur/yazılır — servis bir storage key veya tenantId KABUL ETMEZ,
 * bu nedenle başka kiracının logosunu istemek mümkün değildir.
 */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optText = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());

export const clinicProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(150),
  legalName: optText(250),
  phone: z.preprocess(blank, phoneSchema.optional()),
  email: z.preprocess(blank, emailSchema.optional()),
  website: z.preprocess(
    blank,
    z
      .url({ protocol: /^https?$/ })
      .max(300)
      .optional(),
  ),
  address: optText(500),
  city: optText(80),
  district: optText(80),
  country: z.preprocess(blank, z.string().trim().length(2).toUpperCase().optional()),
  timezone: z.preprocess(blank, z.string().refine(isValidTimeZone, "invalid timezone").optional()),
  defaultAppointmentDurationMinutes: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : Number(v)),
    z.number().int().min(5).max(480).optional(),
  ),
});

export type ClinicProfileView = {
  displayName: string;
  legalName: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  district: string | null;
  country: string;
  timezone: string;
  defaultAppointmentDurationMinutes: number;
  hasLogo: boolean;
  updatedAt: Date | null;
};

async function loadProfile(scope: TenantScope) {
  const [row] = await scope.tx.select().from(clinicProfiles).where(tenantWhere(clinicProfiles, scope));
  return row;
}

export async function getClinicProfile(ctx: AuthContext): Promise<ClinicProfileView> {
  requirePermission(ctx, "clinic.read");
  return tenantQuery(ctx, async (scope) => {
    const row = await loadProfile(scope);
    if (row) {
      const { logoStorageKey, id: _id, tenantId: _t, createdAt: _c, active: _a, ...rest } = row;
      return { ...rest, hasLogo: Boolean(logoStorageKey) };
    }
    // Profil henüz yoksa kiracı adından varsayılan görünüm.
    const [tenant] = await scope.tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, scope.tenantId));
    return {
      displayName: tenant?.name ?? "",
      legalName: null,
      phone: null,
      email: null,
      website: null,
      address: null,
      city: null,
      district: null,
      country: "TR",
      timezone: "Europe/Istanbul",
      defaultAppointmentDurationMinutes: 30,
      hasLogo: false,
      updatedAt: null,
    };
  });
}

/** Profil kiracı yönetimidir → clinic.manage + kiracı geneli kapsam (şube müdürü değiştiremez). */
function requireClinicManager(ctx: AuthContext) {
  requirePermission(ctx, "clinic.manage");
  if (!ctx.branchScope.all) throw new AppError("FORBIDDEN");
}

export async function upsertClinicProfile(ctx: AuthContext, input: unknown): Promise<void> {
  requireClinicManager(ctx);
  const data = parseInput(clinicProfileSchema, input);
  const values = {
    displayName: data.displayName,
    legalName: data.legalName ?? null,
    phone: data.phone ?? null,
    email: data.email ?? null,
    website: data.website ?? null,
    address: data.address ?? null,
    city: data.city ?? null,
    district: data.district ?? null,
    country: data.country ?? "TR",
    timezone: data.timezone ?? "Europe/Istanbul",
    defaultAppointmentDurationMinutes: data.defaultAppointmentDurationMinutes ?? 30,
  };
  await tenantQuery(ctx, async (scope) => {
    const existing = await loadProfile(scope);
    if (existing) {
      await scope.tx.update(clinicProfiles).set(values).where(tenantWhere(clinicProfiles, scope));
    } else {
      await scope.tx.insert(clinicProfiles).values({ ...values, tenantId: scope.tenantId });
    }
    await writeAudit(scope, actorOf(ctx), {
      action: "CLINIC_PROFILE_UPDATED",
      entityType: "clinic_profile",
      metadata: { created: !existing },
    });
  });
}

/** Logo yükleme: doğrula → yeniden kodla → yeni UUID anahtarla özel depoya yaz → profili güncelle. */
export async function uploadClinicLogo(ctx: AuthContext, file: Buffer): Promise<void> {
  requireClinicManager(ctx);
  let processed: Awaited<ReturnType<typeof processLogo>>;
  try {
    processed = await processLogo(file);
  } catch (e) {
    if (e instanceof InvalidLogoError) {
      throw new AppError("VALIDATION", {
        fields: ["logo"],
        message:
          e.reason === "TOO_LARGE"
            ? "Logo en fazla 5 MB olabilir."
            : "Logo yalnızca geçerli bir PNG, JPEG veya WEBP görseli olabilir.",
      });
    }
    throw e;
  }
  const replaced = await tenantQuery(ctx, async (scope) => {
    // Orijinal dosya adı hiçbir yere taşınmaz; anahtar: tenant/<tenantId>/logos/<uuid>.bin
    const key = newStorageKey(scope.tenantId, "logos");
    await getPrivateStorage().put(key, processed.png);
    const existing = await loadProfile(scope);
    if (existing) {
      await scope.tx
        .update(clinicProfiles)
        .set({ logoStorageKey: key })
        .where(tenantWhere(clinicProfiles, scope));
    } else {
      const [tenant] = await scope.tx
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, scope.tenantId));
      await scope.tx
        .insert(clinicProfiles)
        .values({ tenantId: scope.tenantId, displayName: tenant?.name ?? "Klinik", logoStorageKey: key });
    }
    await writeAudit(scope, actorOf(ctx), {
      action: "CLINIC_LOGO_UPDATED",
      entityType: "clinic_profile",
      metadata: { sourceFormat: processed.sourceFormat, width: processed.width, height: processed.height },
    });
    return existing?.logoStorageKey ?? null;
  });
  // Eski logo (transaction commit edildikten sonra) silinir; silme politikası yalnızca logolara izin verir.
  if (replaced && keyBelongsToTenant(replaced, ctx.tenantId)) {
    await getPrivateStorage()
      .deleteIfAllowed(replaced)
      .catch(() => false);
  }
}

/** Oturumdaki kiracının logosu (PNG). Logo yoksa NOT_FOUND. */
export async function readClinicLogo(ctx: AuthContext): Promise<Buffer> {
  requirePermission(ctx, "clinic.read");
  const key = await tenantQuery(ctx, async (scope) => (await loadProfile(scope))?.logoStorageKey ?? null);
  // Savunma derinliği: anahtar kiracı önekini taşımak zorunda.
  if (!key || !keyBelongsToTenant(key, ctx.tenantId)) throw new AppError("NOT_FOUND");
  const data = await getPrivateStorage().get(key);
  if (!data) throw new AppError("NOT_FOUND");
  return data;
}

/** PDF üreticisi için (servis içi): kiracının profil + logo bilgisi. */
export async function clinicBrandingForScope(scope: TenantScope): Promise<{
  displayName: string | null;
  legalName: string | null;
  logoPng: Buffer | null;
}> {
  const row = await loadProfile(scope);
  if (!row) return { displayName: null, legalName: null, logoPng: null };
  let logoPng: Buffer | null = null;
  if (row.logoStorageKey && keyBelongsToTenant(row.logoStorageKey, scope.tenantId)) {
    logoPng = await getPrivateStorage().get(row.logoStorageKey);
  }
  return { displayName: row.displayName, legalName: row.legalName, logoPng };
}
