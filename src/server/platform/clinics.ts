import "server-only";
import { randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/errors";
import { PG_UNIQUE_VIOLATION, pgErrorInfo } from "@/server/db/pg-errors";
import { hashPassword, passwordPolicy } from "@/server/security/password";
import { emailSchema, nameSchema, normalizeEmail, uuidSchema } from "@/server/validation";
import { normalizeUsername, usernameSchema } from "@/server/auth/login-id";
import type { PlatformContext } from "@/server/platform/auth";

/**
 * Platform: klinik (kiracı) yönetimi. Tüm işlemler oturum doğrulayan SECURITY DEFINER fonksiyonlarla yapılır
 * (bkz. migration 0033). Hasta / randevu içeriği dönmez; yalnızca klinik künyesi ve sayılar.
 */
export type ClinicRow = {
  id: string;
  name: string;
  slug: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: Date;
  usersTotal: number;
  usersActive: number;
  branchesTotal: number;
  patientsTotal: number;
  appointments30d: number;
  lastLoginAt: Date | null;
};

export type ClinicOwner = {
  userId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  username: string | null;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
};

/** Veritabanı fonksiyonu hatasını uygulama hatasına çevirir (mesaj / ayrıntı sızdırılmaz). */
function mapError(e: unknown): never {
  const info = pgErrorInfo(e);
  const msg = String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message ?? "");
  if (msg.includes("KLINIVA_FORBIDDEN")) throw new AppError("FORBIDDEN");
  if (msg.includes("KLINIVA_NOT_FOUND")) throw new AppError("NOT_FOUND");
  if (info.code === PG_UNIQUE_VIOLATION) throw new AppError("CONFLICT");
  throw e;
}

export async function listClinics(p: PlatformContext): Promise<ClinicRow[]> {
  const r = await getDb()
    .execute<{
      id: string;
      name: string;
      slug: string;
      status: "ACTIVE" | "SUSPENDED";
      created_at: Date;
      users_total: number;
      users_active: number;
      branches_total: number;
      patients_total: number;
      appointments_30d: number;
      last_login_at: Date | null;
    }>(sql`select * from kliniva.platform_list_tenants(${p.tokenHash})`)
    .catch(mapError);
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    slug: x.slug,
    status: x.status,
    createdAt: new Date(x.created_at),
    usersTotal: x.users_total,
    usersActive: x.users_active,
    branchesTotal: x.branches_total,
    patientsTotal: x.patients_total,
    appointments30d: x.appointments_30d,
    lastLoginAt: x.last_login_at ? new Date(x.last_login_at) : null,
  }));
}

export async function listClinicOwners(p: PlatformContext, rawTenantId: unknown): Promise<ClinicOwner[]> {
  const id = uuidSchema.safeParse(rawTenantId);
  if (!id.success) throw new AppError("NOT_FOUND");
  const r = await getDb()
    .execute<{
      user_id: string;
      first_name: string;
      last_name: string;
      email: string | null;
      username: string | null;
      active: boolean;
      must_change_password: boolean;
      last_login_at: Date | null;
    }>(sql`select * from kliniva.platform_tenant_owners(${p.tokenHash}, ${id.data}::uuid)`)
    .catch(mapError);
  return r.rows.map((x) => ({
    userId: x.user_id,
    firstName: x.first_name,
    lastName: x.last_name,
    email: x.email,
    username: x.username,
    active: x.active,
    mustChangePassword: x.must_change_password,
    lastLoginAt: x.last_login_at ? new Date(x.last_login_at) : null,
  }));
}

/** Rastgele klinik kodu: "kl-" + 6 karakter (karışabilen 0/o/1/l/i yok). */
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function randomClinicCode(): string {
  let s = "kl-";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const createClinicInput = z
  .object({
    name: z.string().trim().min(2, "Klinik adı en az 2 karakter.").max(120),
    city: z.string().trim().min(2, "Şehir girin.").max(80),
    ownerFirstName: nameSchema,
    ownerLastName: nameSchema,
    ownerEmail: z.preprocess(blank, emailSchema.optional()),
    ownerUsername: z.preprocess(blank, usernameSchema.optional()),
    ownerPassword: passwordPolicy,
  })
  .refine((d) => d.ownerEmail || d.ownerUsername, {
    message: "Yönetici için e-posta ya da kullanıcı adı girin.",
    path: ["ownerUsername"],
  });

export async function createClinic(
  p: PlatformContext,
  input: unknown,
): Promise<{ tenantId: string; clinicCode: string; loginId: string }> {
  const parsed = createClinicInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION", {
      fields: [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")))].filter(Boolean),
      message: parsed.error.issues[0]?.message,
    });
  }
  const d = parsed.data;
  const passwordHash = await hashPassword(d.ownerPassword);
  const emailNorm = d.ownerEmail ? normalizeEmail(d.ownerEmail) : null;
  const usernameNorm = d.ownerUsername ? normalizeUsername(d.ownerUsername) : null;
  // Kod çakışırsa (çok düşük olasılık) yeni kodla tekrar dene.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomClinicCode();
    try {
      const r = await getDb().execute<{ tenant_id: string; user_id: string }>(
        sql`select * from kliniva.platform_create_tenant(${p.tokenHash}, ${d.name}, ${code}, ${d.city},
          ${d.ownerFirstName}, ${d.ownerLastName}, ${d.ownerEmail ?? null}, ${emailNorm}, ${usernameNorm},
          ${usernameNorm}, ${passwordHash}, ${p.meta.ipHash ?? null})`,
      );
      return { tenantId: r.rows[0]!.tenant_id, clinicCode: code, loginId: usernameNorm ?? emailNorm! };
    } catch (e) {
      if (pgErrorInfo(e).code === PG_UNIQUE_VIOLATION && attempt < 4) continue;
      mapError(e);
    }
  }
  throw new AppError("CONFLICT");
}

export async function setClinicStatus(
  p: PlatformContext,
  rawTenantId: unknown,
  status: "ACTIVE" | "SUSPENDED",
): Promise<void> {
  const id = uuidSchema.safeParse(rawTenantId);
  if (!id.success) throw new AppError("NOT_FOUND");
  await getDb()
    .execute(
      sql`select kliniva.platform_set_tenant_status(${p.tokenHash}, ${id.data}::uuid, ${status}, ${p.meta.ipHash ?? null})`,
    )
    .catch(mapError);
}

export async function resetOwnerPassword(
  p: PlatformContext,
  rawTenantId: unknown,
  rawUserId: unknown,
  rawPassword: unknown,
): Promise<void> {
  const t = uuidSchema.safeParse(rawTenantId);
  const u = uuidSchema.safeParse(rawUserId);
  if (!t.success || !u.success) throw new AppError("NOT_FOUND");
  const pw = passwordPolicy.safeParse(rawPassword);
  if (!pw.success) {
    throw new AppError("VALIDATION", { fields: ["password"], message: pw.error.issues[0]?.message });
  }
  const hash = await hashPassword(pw.data);
  await getDb()
    .execute(
      sql`select kliniva.platform_reset_owner_password(${p.tokenHash}, ${t.data}::uuid, ${u.data}::uuid, ${hash}, ${p.meta.ipHash ?? null})`,
    )
    .catch(mapError);
}
