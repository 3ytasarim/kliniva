import "server-only";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { patientLookups } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import { actorOf, requirePermission, type AuthContext } from "@/server/auth/authz";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { PG_UNIQUE_VIOLATION, pgErrorInfo } from "@/server/db/pg-errors";
import { uuidSchema } from "@/server/validation";
import type { PatientLookup, PatientLookupKind } from "@/types/patients";

/**
 * Hasta tanımları — kaynak (Google, Instagram, Tavsiye…) ve özel sigorta kurumları. Okuma: patient.read
 * (formlarda seçilir); yönetim: clinic.manage. Silinmez, pasifleştirilir (eski hastalardaki değer korunur).
 */
const kindSchema = z.enum(["SOURCE", "INSURER"]);
const lookupInput = z.object({
  kind: kindSchema,
  name: z.string().trim().min(2, "En az 2 karakter.").max(60),
});

export async function listPatientLookups(
  ctx: AuthContext,
  opts: { kind?: PatientLookupKind; activeOnly?: boolean } = {},
): Promise<PatientLookup[]> {
  requirePermission(ctx, "patient.read");
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select({
        id: patientLookups.id,
        kind: patientLookups.kind,
        name: patientLookups.name,
        active: patientLookups.active,
      })
      .from(patientLookups)
      .where(
        tenantWhere(
          patientLookups,
          scope,
          opts.kind ? eq(patientLookups.kind, opts.kind) : undefined,
          opts.activeOnly ? eq(patientLookups.active, true) : undefined,
        ),
      )
      .orderBy(asc(patientLookups.kind), asc(patientLookups.name)),
  );
}

export async function createPatientLookup(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "clinic.manage");
  const data = parseInput(lookupInput, input);
  return tenantQuery(ctx, async (scope) => {
    const [row] = await scope.tx
      .insert(patientLookups)
      .values({ tenantId: scope.tenantId, kind: data.kind, name: data.name })
      .returning({ id: patientLookups.id })
      .catch((e: unknown) => {
        if (pgErrorInfo(e).code === PG_UNIQUE_VIOLATION) {
          throw new AppError("CONFLICT", { message: "Bu adla bir tanım zaten var." });
        }
        throw e;
      });
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_LOOKUP_CREATED",
      entityType: "patient_lookup",
      entityId: row!.id,
      metadata: { kind: data.kind },
    });
    return { id: row!.id };
  });
}

export async function setPatientLookupActive(
  ctx: AuthContext,
  rawId: unknown,
  active: boolean,
): Promise<void> {
  requirePermission(ctx, "clinic.manage");
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  await tenantQuery(ctx, async (scope) => {
    const res = await scope.tx
      .update(patientLookups)
      .set({ active, updatedAt: new Date() })
      .where(tenantWhere(patientLookups, scope, eq(patientLookups.id, id.data)))
      .returning({ id: patientLookups.id });
    if (!res.length) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_LOOKUP_UPDATED",
      entityType: "patient_lookup",
      entityId: id.data,
      metadata: { active },
    });
  });
}

/**
 * Hasta kaydında seçilen tanımın türü ve etkinliği doğrulanır (DB tetikleyicisi türü ayrıca zorlar). Pasif tanım
 * yeni seçilemez; hastada zaten kayıtlı değer (değişmiyorsa) korunur.
 */
export async function assertLookup(
  scope: TenantScope,
  kind: PatientLookupKind,
  id: string | null | undefined,
  current?: string | null,
): Promise<void> {
  if (!id || id === current) return;
  const [l] = await scope.tx
    .select({ active: patientLookups.active })
    .from(patientLookups)
    .where(tenantWhere(patientLookups, scope, and(eq(patientLookups.id, id), eq(patientLookups.kind, kind))));
  if (!l || !l.active) {
    throw new AppError("VALIDATION", {
      fields: [kind === "SOURCE" ? "sourceId" : "insurerId"],
      message: kind === "SOURCE" ? "Hasta kaynağı bulunamadı." : "Sigorta kurumu bulunamadı.",
    });
  }
}
