import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLogs, clinicalAttachments } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runInTenant } from "@/server/tenant/tenant-query";
import { assignDoctorBranch, createDoctor } from "@/server/services/doctors";
import { addWorkingHour } from "@/server/services/schedule";
import { createPatient } from "@/server/services/patients";
import { createClinicalService, setDoctorServices } from "@/server/services/clinical-services";
import { createAppointment, updateAppointmentStatus } from "@/server/services/appointments";
import {
  ATTACHMENT_MAX_BYTES,
  detectAttachmentMime,
  listClinicalAttachments,
  readClinicalAttachment,
  sanitizeFileName,
  uploadClinicalAttachment,
  voidClinicalAttachment,
} from "@/server/services/clinical-attachments";
import { addDays, dateInZone, isoDayOfWeek, parseTime, zonedDateTimeToUtc } from "@/lib/time";
import { cleanupTenants, createTenant, dbError, type TestTenant } from "../support/fixtures";

/**
 * Sprint 8.2 — muayene dosyaları: içerikten tür doğrulama, boyut, yazma kuralı (randevunun doktoru + hasta gelmiş),
 * okuma kapsamı, şifreli ad, audit'te ad yok, geçersiz kılma (geri alınamaz), DB değişmezliği ve RLS.
 */
const TZ = "Europe/Istanbul";
let A: TestTenant;
let B: TestTenant;
let D1: string;
let S: string;
let P: string;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("sentetik-png-icerik"),
]);
const PDF = Buffer.from("%PDF-1.4\n% sentetik tahlil\n");

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};
function nextMonday(): string {
  let d = addDays(dateInZone(new Date(), TZ), 2);
  while (isoDayOfWeek(d) !== 1) d = addDays(d, 1);
  return d;
}
const book = async (hhmm: string) =>
  (
    await createAppointment(A.users.reception!.ctx, {
      patientId: P,
      branchId: A.branchA,
      doctorId: D1,
      serviceId: S,
      start: zonedDateTimeToUtc(nextMonday(), parseTime(hhmm)!, TZ).toISOString(),
    })
  ).id;

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    reception: { role: "RECEPTION", branch: "A" },
    docA: { role: "DOCTOR" },
    docB: { role: "DOCTOR" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  const owner = A.users.owner!.ctx;
  D1 = (await createDoctor(owner, { mode: "existing", userId: A.users.docA!.id, specialty: "Dermatoloji" }))
    .id;
  await createDoctor(owner, { mode: "existing", userId: A.users.docB!.id, specialty: "Dahiliye" });
  S = (
    await createClinicalService(owner, {
      name: "Muayene",
      defaultDurationMinutes: 30,
      requiresRoom: false,
      allowedRoomTypes: [],
    })
  ).id;
  await assignDoctorBranch(owner, D1, A.branchA);
  for (let dow = 1; dow <= 7; dow++) {
    await addWorkingHour(owner, {
      doctorId: D1,
      branchId: A.branchA,
      dayOfWeek: dow,
      startTime: "08:00",
      endTime: "20:00",
    });
  }
  await setDoctorServices(owner, { doctorId: D1, services: [{ serviceId: S }] });
  P = (
    await createPatient(owner, {
      firstName: "Dosya",
      lastName: "Hasta",
      phone: "05391119001",
      branchId: A.branchA,
    })
  ).id;
}, 120_000);

afterAll(cleanupTenants);

describe("Muayene dosyaları", () => {
  it("tür içerikten belirlenir; ad temizlenir", () => {
    expect(detectAttachmentMime(PNG)).toBe("image/png");
    expect(detectAttachmentMime(PDF)).toBe("application/pdf");
    expect(detectAttachmentMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectAttachmentMime(Buffer.from("RIFF0000WEBPVP8 "))).toBe("image/webp");
    expect(detectAttachmentMime(Buffer.from("<script>alert(1)</script>"))).toBeNull();
    expect(sanitizeFileName('../../etc/x\u0000"y<>.pdf', "application/pdf")).toBe("xy.pdf");
    expect(sanitizeFileName("", "image/png")).toBe("dosya.png");
  });

  it("yükleme kuralı: hasta gelmeden / başkası / yanlış tür / büyük dosya reddedilir; doktor yükler ve okur", async () => {
    const doc = A.users.docA!.ctx;
    const id = await book("09:00");
    expect(await code(uploadClinicalAttachment(doc, id, { name: "a.png", data: PNG }))).toBe("VALIDATION");
    await updateAppointmentStatus(doc, id, { status: "CHECKED_IN" });
    const up = await uploadClinicalAttachment(doc, id, { name: "Hemogram sonucu.pdf", data: PDF });
    await uploadClinicalAttachment(doc, id, { name: "lezyon.png", data: PNG });
    expect(
      await code(uploadClinicalAttachment(doc, id, { name: "x.pdf", data: Buffer.from("not a pdf") })),
    ).toBe("VALIDATION");
    expect(
      await code(
        uploadClinicalAttachment(doc, id, {
          name: "big.pdf",
          data: Buffer.concat([PDF, Buffer.alloc(ATTACHMENT_MAX_BYTES)]),
        }),
      ),
    ).toBe("VALIDATION");
    expect(await code(uploadClinicalAttachment(A.users.owner!.ctx, id, { name: "o.png", data: PNG }))).toBe(
      "FORBIDDEN",
    );
    expect(
      await code(uploadClinicalAttachment(A.users.reception!.ctx, id, { name: "r.png", data: PNG })),
    ).toBe("FORBIDDEN");
    expect(await code(uploadClinicalAttachment(A.users.docB!.ctx, id, { name: "b.png", data: PNG }))).toBe(
      "NOT_FOUND",
    );

    const list = await listClinicalAttachments(A.users.owner!.ctx, id);
    expect(list.items.map((i) => [i.fileName, i.mimeType])).toEqual([
      ["lezyon.png", "image/png"],
      ["Hemogram sonucu.pdf", "application/pdf"],
    ]);
    expect([list.canUpload, list.uploadBlockedReason]).toEqual([
      false,
      "Muayene kaydını yalnızca randevunun doktoru yazar.",
    ]);
    expect((await listClinicalAttachments(doc, id)).canUpload).toBe(true);
    expect(await code(listClinicalAttachments(A.users.reception!.ctx, id))).toBe("FORBIDDEN");
    expect(await code(listClinicalAttachments(A.users.docB!.ctx, id))).toBe("NOT_FOUND");

    const file = await readClinicalAttachment(A.users.owner!.ctx, up.id);
    expect([file.mimeType, file.fileName, file.data.equals(PDF)]).toEqual([
      "application/pdf",
      "Hemogram sonucu.pdf",
      true,
    ]);
    expect(await code(readClinicalAttachment(A.users.docB!.ctx, up.id))).toBe("NOT_FOUND");
    expect(await code(readClinicalAttachment(A.users.reception!.ctx, up.id))).toBe("FORBIDDEN");
    expect(await code(readClinicalAttachment(B.users.owner!.ctx, up.id))).toBe("NOT_FOUND");

    // Ad şifreli; audit'te ad / içerik yok
    const raw = await runInTenant(A.id, (s) =>
      s.tx.select().from(clinicalAttachments).where(eq(clinicalAttachments.appointmentId, id)),
    );
    expect(JSON.stringify(raw)).not.toMatch(/Hemogram|lezyon/);
    const audits = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, id), sql`${auditLogs.action} like 'CLINICAL_ATTACHMENT_%'`)),
    );
    expect(audits.map((x) => x.action).sort()).toEqual([
      "CLINICAL_ATTACHMENT_ADDED",
      "CLINICAL_ATTACHMENT_ADDED",
      "CLINICAL_ATTACHMENT_VIEWED",
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/Hemogram|lezyon|sentetik/);

    // Geçersiz kılma: yalnızca randevunun doktoru; gerekçe; geri alınamaz; artık açılamaz
    expect(await code(voidClinicalAttachment(A.users.owner!.ctx, up.id, { reason: "Yanlış hasta" }))).toBe(
      "FORBIDDEN",
    );
    expect(await code(voidClinicalAttachment(doc, up.id, { reason: "x" }))).toBe("VALIDATION");
    await voidClinicalAttachment(doc, up.id, { reason: "Yanlış dosya" });
    expect(await code(voidClinicalAttachment(doc, up.id, { reason: "Tekrar" }))).toBe("CONFLICT");
    expect(await code(readClinicalAttachment(A.users.owner!.ctx, up.id))).toBe("NOT_FOUND");
    const after = await listClinicalAttachments(doc, id);
    expect(after.items.find((i) => i.id === up.id)).toMatchObject({
      status: "VOIDED",
      voidReason: "Yanlış dosya",
    });
  });

  it("DB: değiştirilemez (iptal dışı UPDATE / DELETE yok), anahtar kiracıya ait, hasta / doktor tutarlı; RLS", async () => {
    const doc = A.users.docA!.ctx;
    const id = await book("11:00");
    await updateAppointmentStatus(doc, id, { status: "CHECKED_IN" });
    const up = await uploadClinicalAttachment(doc, id, { name: "x.png", data: PNG });
    expect(
      (
        await dbError(
          runInTenant(A.id, (s) => s.tx.delete(clinicalAttachments).where(eq(clinicalAttachments.id, up.id))),
        )
      ).code,
    ).toBe("42501");
    const upd = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .update(clinicalAttachments)
          .set({ sha256: "a".repeat(64) })
          .where(eq(clinicalAttachments.id, up.id)),
      ),
    );
    expect(upd.message).toMatch(/KLINIVA_IMMUTABLE/);
    const [row] = await runInTenant(A.id, (s) =>
      s.tx.select().from(clinicalAttachments).where(eq(clinicalAttachments.id, up.id)),
    );
    const insert = (over: Record<string, unknown>) =>
      runInTenant(A.id, (s) =>
        s.tx.insert(clinicalAttachments).values({
          ...row!,
          id: undefined as unknown as string,
          storageKey: `tenant/${A.id}/clinical/${crypto.randomUUID()}.bin`,
          status: "ACTIVE",
          voidedAt: null,
          voidedByUserId: null,
          voidReason: null,
          ...over,
        }),
      );
    expect(
      (await dbError(insert({ storageKey: `tenant/${B.id}/clinical/${crypto.randomUUID()}.bin` }))).message,
    ).toMatch(/KLINIVA_INVALID/);
    const other = (
      await createPatient(A.users.owner!.ctx, {
        firstName: "Diger",
        lastName: "Hasta",
        phone: "05391119002",
        branchId: A.branchA,
      })
    ).id;
    expect((await dbError(insert({ patientId: other }))).message).toMatch(/KLINIVA_INVALID/);
    const fromB = await runInTenant(B.id, (s) =>
      s.tx.execute<{ n: number }>(
        sql`select count(*)::int n from kliniva.clinical_attachments where tenant_id = ${A.id}`,
      ),
    );
    expect(fromB.rows[0]!.n).toBe(0);
  });
});
