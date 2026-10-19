import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { clinicalAttachments, users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import { actorOf, hasPermission, requirePermission, type AuthContext } from "@/server/auth/authz";
import { tenantQuery, tenantWhere } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { getAppointment } from "@/server/services/appointments";
import { selfDoctorProfileId, writeBlock } from "@/server/services/clinical-notes";
import { decryptField, encryptField, sha256Hex } from "@/server/security/crypto";
import { getPrivateStorage, keyBelongsToTenant, newStorageKey } from "@/server/storage/private-storage";
import { uuidSchema } from "@/server/validation";
import type { AttachmentMime, ClinicalAttachmentItem } from "@/types/clinical";

export type { AttachmentMime, ClinicalAttachmentItem };

/**
 * MUAYENE DOSYALARI (sağlık verisi — tahlil sonucu, fotoğraf, PDF).
 *
 *  - Yükleme: muayene kaydıyla aynı kural (patient.health.write + randevunun doktoru + hasta gelmiş).
 *  - Tür içerikten (imza baytları) belirlenir; istemcinin bildirdiği MIME / uzantı KULLANILMAZ. PDF, PNG, JPEG, WEBP;
 *    en çok 5 MB; randevu başına en çok 20 etkin dosya.
 *  - İçerik özel depoda AES-256-GCM ile şifreli (anahtar PII içermez); dosya adı da şifreli; SHA-256 bütünlük özeti
 *    indirirken doğrulanır.
 *  - Okuma / indirme: patient.health.read + randevu görünürlüğü; her indirme audit'lenir (ad / içerik audit'e yazılmaz).
 *  - Silinmez: gerekçeyle geçersiz kılınır (randevunun doktoru); geçersiz dosya indirilemez.
 */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_PER_APPOINTMENT = 20;

/** İçerik imzasından tür (sihirli baytlar). Tanınmayan → null. */
export function detectAttachmentMime(buf: Buffer): AttachmentMime | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Dosya adı: yol / kontrol karakteri yok, en çok 120 karakter; boşsa türden türetilir. */
export function sanitizeFileName(raw: string, mime: AttachmentMime): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "")
    .trim()
    .slice(0, 120);
  if (clean) return clean;
  return `dosya.${mime === "application/pdf" ? "pdf" : mime.split("/")[1]}`;
}

const nameAad = (tenantId: string, id: string) => `clinical_attachment_name:${tenantId}:${id}`;

export async function uploadClinicalAttachment(
  ctx: AuthContext,
  rawAppointmentId: unknown,
  file: { name: string; data: Buffer },
): Promise<{ id: string }> {
  requirePermission(ctx, "patient.health.write");
  if (file.data.length === 0) throw new AppError("VALIDATION", { fields: ["file"], message: "Dosya seçin." });
  if (file.data.length > ATTACHMENT_MAX_BYTES) {
    throw new AppError("VALIDATION", { fields: ["file"], message: "Dosya en fazla 5 MB olabilir." });
  }
  const mime = detectAttachmentMime(file.data);
  if (!mime) {
    throw new AppError("VALIDATION", {
      fields: ["file"],
      message: "Yalnızca PDF, PNG, JPEG veya WEBP dosyası yüklenebilir.",
    });
  }
  const appt = await getAppointment(ctx, rawAppointmentId);
  return tenantQuery(ctx, async (scope) => {
    const self = await selfDoctorProfileId(scope, ctx);
    const block = writeBlock(appt.status, self === appt.doctor.id, true);
    if (block) throw new AppError(self === appt.doctor.id ? "VALIDATION" : "FORBIDDEN", { message: block });
    await scope.tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${scope.tenantId}:clinical_attachment:${appt.id}`}, 0))`,
    );
    const [c] = await scope.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(clinicalAttachments)
      .where(
        tenantWhere(
          clinicalAttachments,
          scope,
          eq(clinicalAttachments.appointmentId, appt.id),
          eq(clinicalAttachments.status, "ACTIVE"),
        ),
      );
    if ((c?.n ?? 0) >= MAX_PER_APPOINTMENT) {
      throw new AppError("VALIDATION", {
        message: `Bir muayeneye en çok ${MAX_PER_APPOINTMENT} dosya eklenebilir.`,
      });
    }
    const id = randomUUID();
    const key = newStorageKey(scope.tenantId, "clinical");
    // Önce depo (yalnızca oluştur), sonra kayıt: kayıt başarısız olursa yetim nesne kalır ama hiçbir kayıt
    // var olmayan bir nesneye işaret etmez (yetim nesne temizliği ayrı bir bakım işidir).
    await getPrivateStorage().put(key, file.data);
    await scope.tx.insert(clinicalAttachments).values({
      id,
      tenantId: scope.tenantId,
      appointmentId: appt.id,
      patientId: appt.patient.id,
      doctorId: appt.doctor.id,
      storageKey: key,
      fileNameEncrypted: encryptField(sanitizeFileName(file.name, mime), nameAad(scope.tenantId, id)),
      mimeType: mime,
      sizeBytes: file.data.length,
      sha256: sha256Hex(file.data),
      createdByUserId: ctx.userId,
    });
    await writeAudit(scope, actorOf(ctx), {
      action: "CLINICAL_ATTACHMENT_ADDED",
      entityType: "appointment",
      entityId: appt.id,
      branchId: appt.branch.id,
      metadata: { mimeType: mime, sizeBytes: file.data.length },
    });
    return { id };
  });
}

export async function listClinicalAttachments(
  ctx: AuthContext,
  rawAppointmentId: unknown,
): Promise<{ items: ClinicalAttachmentItem[]; canUpload: boolean; uploadBlockedReason: string | null }> {
  requirePermission(ctx, "patient.health.read");
  const appt = await getAppointment(ctx, rawAppointmentId);
  return tenantQuery(ctx, async (scope) => {
    const rows = await scope.tx
      .select({
        id: clinicalAttachments.id,
        fileNameEncrypted: clinicalAttachments.fileNameEncrypted,
        mimeType: clinicalAttachments.mimeType,
        sizeBytes: clinicalAttachments.sizeBytes,
        createdAt: clinicalAttachments.createdAt,
        status: clinicalAttachments.status,
        voidReason: clinicalAttachments.voidReason,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(clinicalAttachments)
      .innerJoin(
        users,
        and(
          eq(users.tenantId, clinicalAttachments.tenantId),
          eq(users.id, clinicalAttachments.createdByUserId),
        ),
      )
      .where(tenantWhere(clinicalAttachments, scope, eq(clinicalAttachments.appointmentId, appt.id)))
      .orderBy(desc(clinicalAttachments.createdAt));
    const self = await selfDoctorProfileId(scope, ctx);
    const block = writeBlock(
      appt.status,
      self === appt.doctor.id,
      hasPermission(ctx, "patient.health.write"),
    );
    return {
      canUpload: !block,
      uploadBlockedReason: block,
      items: rows.map((r) => {
        let fileName = "Dosya";
        try {
          fileName = decryptField(r.fileNameEncrypted, nameAad(scope.tenantId, r.id));
        } catch {
          fileName = "Dosya (ad doğrulanamadı)";
        }
        return {
          id: r.id,
          fileName,
          mimeType: r.mimeType as AttachmentMime,
          sizeBytes: r.sizeBytes,
          createdAt: r.createdAt.toISOString(),
          authorName: `${r.firstName} ${r.lastName}`,
          status: r.status,
          voidReason: r.voidReason,
        };
      }),
    };
  });
}

/** İndirme: yetki + randevu görünürlüğü + bütünlük; her başarılı okuma audit'lenir. */
export async function readClinicalAttachment(
  ctx: AuthContext,
  rawId: unknown,
): Promise<{ data: Buffer; mimeType: AttachmentMime; fileName: string }> {
  requirePermission(ctx, "patient.health.read");
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  const row = await tenantQuery(ctx, async (scope) => {
    const [r] = await scope.tx
      .select()
      .from(clinicalAttachments)
      .where(tenantWhere(clinicalAttachments, scope, eq(clinicalAttachments.id, id.data)));
    return r ?? null;
  });
  if (!row || row.status !== "ACTIVE") throw new AppError("NOT_FOUND");
  // Randevu görünürlüğü (doktor: yalnızca kendi randevuları; şube kapsamı) — görünmüyorsa NOT_FOUND.
  const appt = await getAppointment(ctx, row.appointmentId);
  if (!keyBelongsToTenant(row.storageKey, ctx.tenantId)) throw new AppError("NOT_FOUND");
  const data = await getPrivateStorage().get(row.storageKey);
  if (!data || sha256Hex(data) !== row.sha256) throw new AppError("DOCUMENT_INTEGRITY_FAILED");
  return tenantQuery(ctx, async (scope) => {
    await writeAudit(scope, actorOf(ctx), {
      action: "CLINICAL_ATTACHMENT_VIEWED",
      entityType: "appointment",
      entityId: appt.id,
      branchId: appt.branch.id,
      metadata: { mimeType: row.mimeType },
    });
    return {
      data,
      mimeType: row.mimeType as AttachmentMime,
      fileName: decryptField(row.fileNameEncrypted, nameAad(scope.tenantId, row.id)),
    };
  });
}

const voidInput = z.object({ reason: z.string().trim().min(3, "Gerekçe en az 3 karakter.").max(300) });

/** Geçersiz kılma: yalnızca randevunun doktoru (patient.health.write); gerekçe zorunlu, geri alınamaz. */
export async function voidClinicalAttachment(
  ctx: AuthContext,
  rawId: unknown,
  input: unknown,
): Promise<void> {
  requirePermission(ctx, "patient.health.write");
  const data = parseInput(voidInput, input);
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  const row = await tenantQuery(ctx, async (scope) => {
    const [r] = await scope.tx
      .select({ appointmentId: clinicalAttachments.appointmentId, status: clinicalAttachments.status })
      .from(clinicalAttachments)
      .where(tenantWhere(clinicalAttachments, scope, eq(clinicalAttachments.id, id.data)));
    return r ?? null;
  });
  if (!row) throw new AppError("NOT_FOUND");
  const appt = await getAppointment(ctx, row.appointmentId);
  await tenantQuery(ctx, async (scope) => {
    const self = await selfDoctorProfileId(scope, ctx);
    if (self !== appt.doctor.id) {
      throw new AppError("FORBIDDEN", { message: "Dosyayı yalnızca randevunun doktoru geçersiz kılabilir." });
    }
    if (row.status !== "ACTIVE") throw new AppError("CONFLICT", { message: "Dosya zaten geçersiz." });
    await scope.tx
      .update(clinicalAttachments)
      .set({ status: "VOIDED", voidedAt: sql`now()`, voidedByUserId: ctx.userId, voidReason: data.reason })
      .where(tenantWhere(clinicalAttachments, scope, eq(clinicalAttachments.id, id.data)));
    await writeAudit(scope, actorOf(ctx), {
      action: "CLINICAL_ATTACHMENT_VOIDED",
      entityType: "appointment",
      entityId: appt.id,
      branchId: appt.branch.id,
    });
  });
}
