import "server-only";
import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { clinicProfiles, labPanels, labResults, users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import { actorOf, hasPermission, requirePermission, type AuthContext } from "@/server/auth/authz";
import { tenantQuery, tenantWhere } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { PG_UNIQUE_VIOLATION, pgErrorInfo } from "@/server/db/pg-errors";
import { loadVisiblePatient } from "@/server/services/patients";
import { loadAccessibleAppointment } from "@/server/services/appointments";
import { decryptField, encryptField } from "@/server/security/crypto";
import { DEFAULT_TIMEZONE, dateInZone, isValidDate } from "@/lib/time";
import { uuidSchema } from "@/server/validation";
import type { LabFlag, LabPanel, LabParameter, LabResultItem, LabValue } from "@/types/labs";

/**
 * TAHLİLLER.
 *  - Tipler (panel + parametreler): yönetim clinic.manage; okuma patient.health.read veya clinic.manage.
 *  - Sonuç: yazma patient.health.write, okuma patient.health.read; hasta görünür olmalı (şube kapsamı).
 *  - Değerler şifreli JSON (aad: kiracı + sonuç); girildiği andaki ad / birim / aralık sonuca kopyalanır.
 *  - Referans dışı değer: sayısal değer aralığın altında (L) / üstünde (H). Metin değer ("negatif") işaretlenmez.
 *  - Düzeltme yok: gerekçeyle geçersiz kılınır (DB tetikleyicisi); audit'e değer / gerekçe yazılmaz.
 */
export const LAB_MAX_PARAMETERS = 40;

const num = (raw: string): number | null => {
  const s = raw.trim().replace(",", ".");
  if (!s) return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
};

const slug = (name: string) =>
  name
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);

/**
 * "Ad | birim | alt | üst" satırlarını parametre listesine çevirir. Birim ve sınırlar isteğe bağlıdır.
 * Hatalı satırda satır numarasıyla VALIDATION.
 */
export function parseParametersText(text: string): LabParameter[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length)
    throw new AppError("VALIDATION", { fields: ["parameters"], message: "En az bir parametre girin." });
  if (lines.length > LAB_MAX_PARAMETERS) {
    throw new AppError("VALIDATION", {
      fields: ["parameters"],
      message: `En fazla ${LAB_MAX_PARAMETERS} parametre.`,
    });
  }
  const seen = new Set<string>();
  return lines.map((line, i) => {
    const [name = "", unit = "", lowRaw = "", highRaw = ""] = line.split("|").map((x) => x.trim());
    const fail = (why: string): never => {
      throw new AppError("VALIDATION", { fields: ["parameters"], message: `${i + 1}. satır: ${why}` });
    };
    if (name.length < 1 || name.length > 60) fail("parametre adı 1–60 karakter olmalı.");
    if (unit.length > 20) fail("birim en fazla 20 karakter.");
    const low = num(lowRaw);
    const high = num(highRaw);
    if (Number.isNaN(low) || Number.isNaN(high)) fail("alt / üst sınır sayı olmalı.");
    if (low !== null && high !== null && low > high) fail("alt sınır üst sınırdan büyük olamaz.");
    const key = slug(name) || `p${i + 1}`;
    if (seen.has(key)) fail("aynı adla iki parametre var.");
    seen.add(key);
    return { key, name, unit, low, high };
  });
}

export const parametersToText = (ps: LabParameter[]) =>
  ps
    .map((p) =>
      [p.name, p.unit, p.low ?? "", p.high ?? ""]
        .map(String)
        .join(" | ")
        .replace(/( \| )+$/, ""),
    )
    .join("\n");

const panelInput = z.object({
  name: z.string().trim().min(2, "En az 2 karakter.").max(80),
  parameters: z.string().max(6000),
  active: z.preprocess(
    (v) => (v === undefined ? true : v === true || v === "on" || v === "true"),
    z.boolean(),
  ),
});

const mapUnique = (e: unknown): never => {
  if (pgErrorInfo(e).code === PG_UNIQUE_VIOLATION) {
    throw new AppError("CONFLICT", { message: "Bu adla bir tahlil tipi zaten var." });
  }
  throw e;
};

export async function listLabPanels(
  ctx: AuthContext,
  opts: { activeOnly?: boolean } = {},
): Promise<LabPanel[]> {
  if (!hasPermission(ctx, "patient.health.read") && !hasPermission(ctx, "clinic.manage")) {
    throw new AppError("FORBIDDEN");
  }
  const rows = await tenantQuery(ctx, (scope) =>
    scope.tx
      .select()
      .from(labPanels)
      .where(tenantWhere(labPanels, scope, opts.activeOnly ? eq(labPanels.active, true) : undefined))
      .orderBy(asc(labPanels.name)),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    parameters: r.parameters as LabParameter[],
    active: r.active,
  }));
}

export async function createLabPanel(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "clinic.manage");
  const data = parseInput(panelInput, input);
  const parameters = parseParametersText(data.parameters);
  return tenantQuery(ctx, async (scope) => {
    const [row] = await scope.tx
      .insert(labPanels)
      .values({ tenantId: scope.tenantId, name: data.name, parameters, active: data.active })
      .returning({ id: labPanels.id })
      .catch(mapUnique);
    await writeAudit(scope, actorOf(ctx), {
      action: "LAB_PANEL_CREATED",
      entityType: "lab_panel",
      entityId: row!.id,
      metadata: { parameters: parameters.length },
    });
    return { id: row!.id };
  });
}

export async function updateLabPanel(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "clinic.manage");
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  const data = parseInput(panelInput, input);
  const parameters = parseParametersText(data.parameters);
  await tenantQuery(ctx, async (scope) => {
    const res = await scope.tx
      .update(labPanels)
      .set({ name: data.name, parameters, active: data.active, updatedAt: new Date() })
      .where(tenantWhere(labPanels, scope, eq(labPanels.id, id.data)))
      .returning({ id: labPanels.id })
      .catch(mapUnique);
    if (!res.length) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: "LAB_PANEL_UPDATED",
      entityType: "lab_panel",
      entityId: id.data,
      metadata: { parameters: parameters.length, active: data.active },
    });
  });
}

export function flagOf(value: string, p: Pick<LabParameter, "low" | "high">): LabFlag {
  const n = num(value);
  if (n === null || Number.isNaN(n)) return null;
  if (p.low !== null && n < p.low) return "L";
  if (p.high !== null && n > p.high) return "H";
  return null;
}

const resultInput = z.object({
  patientId: uuidSchema,
  panelId: uuidSchema,
  appointmentId: z.preprocess((v) => (v === "" ? undefined : v), uuidSchema.optional()),
  sampleDate: z.string().refine(isValidDate, "Geçerli bir tarih girin."),
});
const aad = (tenantId: string, id: string) => `lab_result:${tenantId}:${id}`;

/**
 * Sonuç ekler. Değerler input'ta "v_<parametre anahtarı>" alanlarıdır; boş bırakılan parametre kaydedilmez.
 */
export async function addLabResult(
  ctx: AuthContext,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  requirePermission(ctx, "patient.health.write");
  const data = parseInput(resultInput, input);
  return tenantQuery(ctx, async (scope) => {
    const patient = await loadVisiblePatient(scope, ctx, data.patientId);
    if (data.appointmentId) {
      const a = await loadAccessibleAppointment(scope, ctx, data.appointmentId);
      if (a.patientId !== patient.id) throw new AppError("NOT_FOUND");
    }
    const [panel] = await scope.tx
      .select()
      .from(labPanels)
      .where(tenantWhere(labPanels, scope, eq(labPanels.id, data.panelId), eq(labPanels.active, true)));
    if (!panel) throw new AppError("VALIDATION", { fields: ["panelId"], message: "Tahlil tipi bulunamadı." });
    const [p] = await scope.tx
      .select({ tz: clinicProfiles.timezone })
      .from(clinicProfiles)
      .where(tenantWhere(clinicProfiles, scope));
    if (data.sampleDate > dateInZone(new Date(), p?.tz ?? DEFAULT_TIMEZONE)) {
      throw new AppError("VALIDATION", {
        fields: ["sampleDate"],
        message: "Numune tarihi ileri bir tarih olamaz.",
      });
    }
    const values: LabValue[] = [];
    for (const param of panel.parameters as LabParameter[]) {
      const raw = input[`v_${param.key}`];
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) continue;
      if (value.length > 40) {
        throw new AppError("VALIDATION", {
          fields: [`v_${param.key}`],
          message: `${param.name}: en fazla 40 karakter.`,
        });
      }
      values.push({ ...param, value, flag: flagOf(value, param) });
    }
    if (!values.length) throw new AppError("VALIDATION", { message: "En az bir değer girin." });
    const id = crypto.randomUUID();
    const abnormalCount = values.filter((v) => v.flag).length;
    await scope.tx.insert(labResults).values({
      id,
      tenantId: scope.tenantId,
      patientId: patient.id,
      panelId: panel.id,
      appointmentId: data.appointmentId ?? null,
      sampleDate: data.sampleDate,
      valuesEncrypted: encryptField(JSON.stringify(values), aad(scope.tenantId, id)),
      abnormalCount,
      createdByUserId: ctx.userId,
    });
    await writeAudit(scope, actorOf(ctx), {
      action: "LAB_RESULT_ADDED",
      entityType: "patient",
      entityId: patient.id,
      branchId: patient.primaryBranchId,
      metadata: { values: values.length, abnormal: abnormalCount },
    });
    return { id };
  });
}

/** Hastanın tahlil sonuçları (en yeni önce). Görüntüleme audit'lenir (LAB_RESULTS_VIEWED; değer yazılmaz). */
export async function listLabResults(ctx: AuthContext, rawPatientId: unknown): Promise<LabResultItem[]> {
  requirePermission(ctx, "patient.health.read");
  return tenantQuery(ctx, async (scope) => {
    const patient = await loadVisiblePatient(scope, ctx, rawPatientId);
    const rows = await scope.tx
      .select({
        r: labResults,
        panelName: labPanels.name,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(labResults)
      .innerJoin(
        labPanels,
        and(eq(labPanels.tenantId, labResults.tenantId), eq(labPanels.id, labResults.panelId)),
      )
      .innerJoin(
        users,
        and(eq(users.tenantId, labResults.tenantId), eq(users.id, labResults.createdByUserId)),
      )
      .where(tenantWhere(labResults, scope, eq(labResults.patientId, patient.id)))
      .orderBy(desc(labResults.sampleDate), desc(labResults.createdAt));
    if (rows.length) {
      await writeAudit(scope, actorOf(ctx), {
        action: "LAB_RESULTS_VIEWED",
        entityType: "patient",
        entityId: patient.id,
        branchId: patient.primaryBranchId,
        metadata: { results: rows.length },
      });
    }
    return rows.map(({ r, ...x }) => {
      let values: LabValue[] = [];
      let integrityError = false;
      try {
        values = JSON.parse(decryptField(r.valuesEncrypted, aad(scope.tenantId, r.id))) as LabValue[];
      } catch {
        integrityError = true;
      }
      return {
        id: r.id,
        panelId: r.panelId,
        panelName: x.panelName,
        sampleDate: r.sampleDate,
        values,
        abnormalCount: r.abnormalCount,
        status: r.status,
        voidReason: r.voidReason,
        createdByName: `${x.firstName} ${x.lastName}`,
        createdAt: r.createdAt.toISOString(),
        integrityError,
      };
    });
  });
}

const voidInput = z.object({ reason: z.string().trim().min(3, "Gerekçe en az 3 karakter.").max(300) });

export async function voidLabResult(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "patient.health.write");
  const data = parseInput(voidInput, input);
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  await tenantQuery(ctx, async (scope) => {
    const [r] = await scope.tx
      .select({ patientId: labResults.patientId, status: labResults.status })
      .from(labResults)
      .where(tenantWhere(labResults, scope, eq(labResults.id, id.data)))
      .for("update");
    if (!r) throw new AppError("NOT_FOUND");
    const patient = await loadVisiblePatient(scope, ctx, r.patientId); // kapsam dışı → NOT_FOUND
    if (r.status !== "ACTIVE") throw new AppError("CONFLICT", { message: "Sonuç zaten geçersiz." });
    await scope.tx
      .update(labResults)
      .set({ status: "VOIDED", voidedAt: new Date(), voidedByUserId: ctx.userId, voidReason: data.reason })
      .where(tenantWhere(labResults, scope, eq(labResults.id, id.data)));
    await writeAudit(scope, actorOf(ctx), {
      action: "LAB_RESULT_VOIDED",
      entityType: "patient",
      entityId: patient.id,
      branchId: patient.primaryBranchId,
    });
  });
}
