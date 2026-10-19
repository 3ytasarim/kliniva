import "server-only";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { clinicalNotes, doctorProfiles, users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import { actorOf, hasPermission, requirePermission, type AuthContext } from "@/server/auth/authz";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { getAppointment } from "@/server/services/appointments";
import { decryptField, encryptField, sha256Hex } from "@/server/security/crypto";
import type { AppointmentStatus } from "@/types/appointments";

/**
 * MUAYENE KAYDI (sağlık verisi — KVKK özel nitelikli). Randevuya bağlı: şikâyet, bulgular, yapılan işlemler, plan.
 *
 *  - Yazma: patient.health.write + YALNIZCA randevunun doktoru + hasta gelmiş olmalı (Geldi / Muayenede / Tamamlandı).
 *  - Okuma: patient.health.read + randevu görünürlüğü (doktor: kendi randevuları; servis kapsamı).
 *  - Her kaydetme YENİ SÜRÜM (DB: yalnızca ekleme, sürüm sırası tetikleyicide); aynı içerik yeni sürüm üretmez.
 *  - İçerik AES-256-GCM (aad: kiracı + randevu + sürüm) + SHA-256 bütünlük özeti; okumada doğrulanır.
 *  - Audit: CLINICAL_NOTE_SAVED / CLINICAL_NOTE_VIEWED — yalnızca sürüm numarası, İÇERİK YOK.
 *  - Sesli / yazılı asistanın bu kayda erişen aracı YOKTUR (tıbbi içerik yapay zekâya verilmez).
 */
export type ClinicalNoteContent = {
  complaint: string;
  /** Sprint 8.2: öykü / geçmiş (eski sürümlerde yok → ""). */
  history: string;
  findings: string;
  procedures: string;
  plan: string;
  /** Sprint 8.2: hastaya verilen tavsiyeler (eski sürümlerde yok → ""). */
  advice: string;
};
const NOTE_KEYS = ["complaint", "history", "findings", "procedures", "plan", "advice"] as const;
/** Eski sürümlerde bulunmayan alanlar boş metin olarak tamamlanır (şema genişlese de eski kayıt okunur). */
const normalizeContent = (c: Partial<ClinicalNoteContent>): ClinicalNoteContent =>
  Object.fromEntries(NOTE_KEYS.map((k) => [k, typeof c[k] === "string" ? c[k] : ""])) as ClinicalNoteContent;
export const CLINICAL_NOTE_FIELDS: { key: keyof ClinicalNoteContent; label: string; hint: string }[] = [
  { key: "complaint", label: "Şikâyet", hint: "Hastanın başvuru nedeni / anlattıkları" },
  { key: "history", label: "Öykü / geçmiş", hint: "Önceki tedaviler, ameliyatlar, aile öyküsü" },
  { key: "findings", label: "Muayene bulguları", hint: "Gözlem ve muayene sonuçları" },
  { key: "procedures", label: "Yapılan işlemler", hint: "Bu muayenede yapılanlar" },
  { key: "plan", label: "Tedavi planı", hint: "Tedavi, kontrol tarihi, istenen tetkikler" },
  { key: "advice", label: "Hastaya tavsiyeler", hint: "Bakım, ilaç kullanımı, dikkat edilecekler" },
];

export type ClinicalNoteView = {
  latest: {
    version: number;
    content: ClinicalNoteContent;
    createdAt: string;
    authorName: string;
  } | null;
  versions: { version: number; createdAt: string; authorName: string }[];
  integrityError: boolean;
  canWrite: boolean;
  /** Yazılamıyorsa nedeni (arayüz bilgisi). */
  writeBlockedReason: string | null;
};

const WRITABLE: AppointmentStatus[] = ["CHECKED_IN", "IN_PROGRESS", "COMPLETED"];
const text = z
  .string()
  .max(4000, "En fazla 4000 karakter.")
  .optional()
  .transform((v) => (v ?? "").trim());
const contentInput = z
  .object({ complaint: text, history: text, findings: text, procedures: text, plan: text, advice: text })
  .refine((c) => Object.values(c).some((v) => v.length > 0), { message: "En az bir alanı doldurun." });

const aad = (tenantId: string, appointmentId: string, version: number) =>
  `clinical_note:${tenantId}:${appointmentId}:${version}`;

export async function selfDoctorProfileId(scope: TenantScope, ctx: AuthContext): Promise<string | null> {
  const [d] = await scope.tx
    .select({ id: doctorProfiles.id })
    .from(doctorProfiles)
    .where(tenantWhere(doctorProfiles, scope, eq(doctorProfiles.userId, ctx.userId)));
  return d?.id ?? null;
}

export function writeBlock(
  status: AppointmentStatus,
  isTreatingDoctor: boolean,
  canHealthWrite: boolean,
): string | null {
  if (!canHealthWrite) return "Muayene kaydı yazma yetkiniz yok.";
  if (!isTreatingDoctor) return "Muayene kaydını yalnızca randevunun doktoru yazar.";
  if (!WRITABLE.includes(status)) return "Muayene kaydı hasta geldikten sonra yazılır.";
  return null;
}

export async function getClinicalNote(
  ctx: AuthContext,
  rawAppointmentId: unknown,
): Promise<ClinicalNoteView> {
  requirePermission(ctx, "patient.health.read");
  const appt = await getAppointment(ctx, rawAppointmentId); // kapsam: görünmeyen randevu → NOT_FOUND
  return tenantQuery(ctx, async (scope) => {
    const rows = await scope.tx
      .select({
        version: clinicalNotes.version,
        contentEncrypted: clinicalNotes.contentEncrypted,
        contentHash: clinicalNotes.contentHash,
        createdAt: clinicalNotes.createdAt,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(clinicalNotes)
      .innerJoin(
        users,
        and(eq(users.tenantId, clinicalNotes.tenantId), eq(users.id, clinicalNotes.createdByUserId)),
      )
      .where(tenantWhere(clinicalNotes, scope, eq(clinicalNotes.appointmentId, appt.id)))
      .orderBy(desc(clinicalNotes.version));
    const self = await selfDoctorProfileId(scope, ctx);
    const block = writeBlock(
      appt.status,
      self === appt.doctor.id,
      hasPermission(ctx, "patient.health.write"),
    );
    const versions = rows.map((r) => ({
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      authorName: `${r.firstName} ${r.lastName}`,
    }));
    const top = rows[0];
    if (!top)
      return { latest: null, versions, integrityError: false, canWrite: !block, writeBlockedReason: block };
    let content: ClinicalNoteContent | null = null;
    let integrityError = false;
    if (sha256Hex(top.contentEncrypted) !== top.contentHash) integrityError = true;
    else {
      try {
        content = normalizeContent(
          JSON.parse(decryptField(top.contentEncrypted, aad(scope.tenantId, appt.id, top.version))),
        );
      } catch {
        integrityError = true;
      }
    }
    await writeAudit(scope, actorOf(ctx), {
      action: "CLINICAL_NOTE_VIEWED",
      entityType: "appointment",
      entityId: appt.id,
      branchId: appt.branch.id,
      metadata: { version: top.version, integrityError },
    });
    return {
      latest: content
        ? {
            version: top.version,
            content,
            createdAt: versions[0]!.createdAt,
            authorName: versions[0]!.authorName,
          }
        : null,
      versions,
      integrityError,
      canWrite: !block && !integrityError,
      writeBlockedReason: integrityError ? "Kayıt bütünlüğü doğrulanamadı; yöneticinize bildirin." : block,
    };
  });
}

export async function saveClinicalNote(
  ctx: AuthContext,
  rawAppointmentId: unknown,
  input: unknown,
): Promise<{ version: number; unchanged: boolean }> {
  requirePermission(ctx, "patient.health.write");
  const data = parseInput(contentInput, input);
  const appt = await getAppointment(ctx, rawAppointmentId);
  return tenantQuery(ctx, async (scope) => {
    const self = await selfDoctorProfileId(scope, ctx);
    const block = writeBlock(appt.status, self === appt.doctor.id, true);
    if (block) throw new AppError(self === appt.doctor.id ? "VALIDATION" : "FORBIDDEN", { message: block });
    // Aynı randevuya eşzamanlı kaydetmeler sıralanır (sürüm numarası çakışmaz).
    await scope.tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${scope.tenantId}:clinical_note:${appt.id}`}, 0))`,
    );
    const [last] = await scope.tx
      .select({ version: clinicalNotes.version, contentEncrypted: clinicalNotes.contentEncrypted })
      .from(clinicalNotes)
      .where(tenantWhere(clinicalNotes, scope, eq(clinicalNotes.appointmentId, appt.id)))
      .orderBy(desc(clinicalNotes.version))
      .limit(1);
    const json = JSON.stringify(normalizeContent(data));
    if (last) {
      try {
        const prev = decryptField(last.contentEncrypted, aad(scope.tenantId, appt.id, last.version));
        if (JSON.stringify(normalizeContent(JSON.parse(prev))) === json) {
          return { version: last.version, unchanged: true };
        }
      } catch {
        // önceki sürüm çözülemiyorsa yine de yeni sürüm yazılır (eskisi değişmeden kalır)
      }
    }
    const version = (last?.version ?? 0) + 1;
    const contentEncrypted = encryptField(json, aad(scope.tenantId, appt.id, version));
    await scope.tx.insert(clinicalNotes).values({
      tenantId: scope.tenantId,
      appointmentId: appt.id,
      patientId: appt.patient.id,
      doctorId: appt.doctor.id,
      version,
      contentEncrypted,
      contentHash: sha256Hex(contentEncrypted),
      createdByUserId: ctx.userId,
    });
    await writeAudit(scope, actorOf(ctx), {
      action: "CLINICAL_NOTE_SAVED",
      entityType: "appointment",
      entityId: appt.id,
      branchId: appt.branch.id,
      metadata: { version },
    });
    return { version, unchanged: false };
  });
}
