import "server-only";
import { randomUUID } from "node:crypto";
import { asc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { patients, tenants } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import {
  actorOf,
  branchFilter,
  hasPermission,
  requireBranchAccess,
  requirePermission,
  type AuthContext,
} from "@/server/auth/authz";
import { decryptField, encryptField } from "@/server/security/crypto";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { emailSchema, nameSchema, phoneSchema, uuidSchema } from "@/server/validation";

/**
 * Hasta servisi.
 *  - patient.read: kimlik/iletişim (liste ekranında telefon maskeli — minimum gerekli veri).
 *  - patient.health.read: tıbbi not (HEALTH_SPECIAL_CATEGORY) — yalnızca bu yetkiyle çözülür ve döner.
 *  - Başka kiracının / erişilemeyen şubenin hastası "bulunamadı" olarak döner (IDOR varlık sızdırmaz).
 *  - Notlar AES-256-GCM ile, hasta + kiracı kimliğine bağlı AAD ile şifrelenir.
 */
const notesAad = (tenantId: string, patientId: string) => `patient.notes:${tenantId}:${patientId}`;

const optionalText = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

export const createPatientSchema = z.object({
  branchId: optionalText(uuidSchema),
  firstName: nameSchema,
  lastName: nameSchema,
  phone: phoneSchema,
  email: optionalText(emailSchema),
  birthDate: optionalText(z.iso.date()),
  gender: optionalText(z.enum(["FEMALE", "MALE", "OTHER", "UNDISCLOSED"])),
  notes: optionalText(z.string().max(10_000)),
});

export const updatePatientSchema = createPatientSchema.partial().extend({
  active: z.boolean().optional(),
});

export type PatientListItem = {
  id: string;
  patientNumber: string;
  firstName: string;
  lastName: string;
  phoneMasked: string;
  branchId: string | null;
  active: boolean;
};

export type PatientDetail = {
  id: string;
  patientNumber: string;
  branchId: string | null;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  birthDate: string | null;
  gender: string | null;
  active: boolean;
  /** Yalnızca patient.health.read yetkisinde dolu; aksi halde alan hiç gönderilmez. */
  health?: { notes: string | null };
};

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 4 ? "****" : `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

async function loadPatientRow(scope: TenantScope, ctx: AuthContext, rawId: unknown) {
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  const [row] = await scope.tx
    .select()
    .from(patients)
    .where(tenantWhere(patients, scope, eq(patients.id, id.data)));
  // Kayıt yok, başka kiracıda veya erişilemeyen şubede → hepsi aynı yanıt.
  if (!row || !(ctx.branchScope.all || (row.branchId && ctx.branchScope.branchIds.has(row.branchId)))) {
    throw new AppError("NOT_FOUND");
  }
  return row;
}

export async function listPatients(ctx: AuthContext, opts: { q?: string } = {}): Promise<PatientListItem[]> {
  requirePermission(ctx, "patient.read");
  const q = opts.q?.trim().slice(0, 100);
  return tenantQuery(ctx, async (scope) => {
    const rows = await scope.tx
      .select({
        id: patients.id,
        patientNumber: patients.patientNumber,
        firstName: patients.firstName,
        lastName: patients.lastName,
        phone: patients.phone,
        branchId: patients.branchId,
        active: patients.active,
      })
      .from(patients)
      .where(
        tenantWhere(
          patients,
          scope,
          branchFilter(ctx, patients.branchId),
          q
            ? or(
                ilike(patients.firstName, `%${q.replace(/[%_\\]/g, "\\$&")}%`),
                ilike(patients.lastName, `%${q.replace(/[%_\\]/g, "\\$&")}%`),
                eq(patients.patientNumber, q),
              )
            : undefined,
        ),
      )
      .orderBy(asc(patients.lastName), asc(patients.firstName))
      .limit(200);
    return rows.map(({ phone, ...r }) => ({ ...r, phoneMasked: maskPhone(phone) }));
  });
}

export async function getPatient(ctx: AuthContext, rawId: unknown): Promise<PatientDetail> {
  requirePermission(ctx, "patient.read");
  const canHealth = hasPermission(ctx, "patient.health.read");
  return tenantQuery(ctx, async (scope) => {
    const row = await loadPatientRow(scope, ctx, rawId);
    const detail: PatientDetail = {
      id: row.id,
      patientNumber: row.patientNumber,
      branchId: row.branchId,
      firstName: row.firstName,
      lastName: row.lastName,
      phone: row.phone,
      email: row.email,
      birthDate: row.birthDate,
      gender: row.gender,
      active: row.active,
    };
    if (canHealth) {
      detail.health = {
        notes: row.notesEncrypted ? decryptField(row.notesEncrypted, notesAad(scope.tenantId, row.id)) : null,
      };
    }
    await writeAudit(scope, actorOf(ctx), {
      action: canHealth ? "PATIENT_HEALTH_VIEWED" : "PATIENT_VIEWED",
      entityType: "patient",
      entityId: row.id,
      branchId: row.branchId,
    });
    return detail;
  });
}

export async function createPatient(
  ctx: AuthContext,
  input: unknown,
): Promise<{ id: string; patientNumber: string }> {
  requirePermission(ctx, "patient.create");
  const data = parseInput(createPatientSchema, input);
  if (data.notes) requirePermission(ctx, "patient.health.write");
  // Şube kapsamlı kullanıcı yalnızca kendi şubesine, şubesiz hasta oluşturamaz.
  requireBranchAccess(ctx, data.branchId ?? null);

  return tenantQuery(ctx, async (scope) => {
    const [seq] = await scope.tx
      .update(tenants)
      .set({ patientSeq: sql`${tenants.patientSeq} + 1` })
      .where(eq(tenants.id, scope.tenantId))
      .returning({ value: tenants.patientSeq });
    const patientNumber = `P-${String(seq!.value).padStart(6, "0")}`;
    const id = randomUUID();
    await scope.tx.insert(patients).values({
      id,
      tenantId: scope.tenantId,
      branchId: data.branchId ?? null,
      patientNumber,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
      email: data.email ?? null,
      birthDate: data.birthDate ?? null,
      gender: data.gender ?? null,
      notesEncrypted: data.notes ? encryptField(data.notes, notesAad(scope.tenantId, id)) : null,
      createdByUserId: ctx.userId,
    });
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_CREATED",
      entityType: "patient",
      entityId: id,
      branchId: data.branchId ?? null,
      metadata: { hasHealthNotes: Boolean(data.notes) },
    });
    return { id, patientNumber };
  });
}

export async function updatePatient(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "patient.update");
  const data = parseInput(updatePatientSchema, input);
  if (data.notes !== undefined) requirePermission(ctx, "patient.health.write");
  if (data.active === false) requirePermission(ctx, "patient.delete");

  await tenantQuery(ctx, async (scope) => {
    const row = await loadPatientRow(scope, ctx, rawId);
    if (data.branchId !== undefined) requireBranchAccess(ctx, data.branchId);

    const changed = Object.keys(data).filter((k) => (data as Record<string, unknown>)[k] !== undefined);
    const { notes, ...rest } = data;
    await scope.tx
      .update(patients)
      .set({
        ...rest,
        ...(notes !== undefined
          ? { notesEncrypted: notes ? encryptField(notes, notesAad(scope.tenantId, row.id)) : null }
          : {}),
      })
      .where(tenantWhere(patients, scope, eq(patients.id, row.id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_UPDATED",
      entityType: "patient",
      entityId: row.id,
      branchId: row.branchId,
      // Yalnızca değişen ALAN ADLARI (değerler değil) ve sağlık verisi değişti mi bayrağı.
      metadata: {
        fields: changed.filter((f) => f !== "notes").join(","),
        healthNotesChanged: notes !== undefined,
      },
    });
  });
}

/** Testler ve iç kullanım için: hasta kaydının kimliğe göre varlığı (aynı kiracı + şube kapsamı). */
export async function patientExists(ctx: AuthContext, rawId: unknown): Promise<boolean> {
  requirePermission(ctx, "patient.read");
  return tenantQuery(ctx, async (scope) => {
    try {
      await loadPatientRow(scope, ctx, rawId);
      return true;
    } catch {
      return false;
    }
  });
}
