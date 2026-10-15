import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { getPool } from "@/server/db/client";
import { getMigrationDb } from "@/server/db/migration-client";
import { auditLogs, patientDocuments } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runInTenant, tenantQuery } from "@/server/tenant/tenant-query";
import { sha256Hex } from "@/server/security/crypto";
import {
  createPatient,
  findPossibleDuplicatePatients,
  getPatient,
  listPatients,
} from "@/server/services/patients";
import {
  createPatientDocument,
  createTemplateVersion,
  getCurrentConsentState,
  getDocumentPreview,
  getPatientDocument,
  listPatientDocuments,
  presentPatientDocument,
  publishTemplate,
  readDocumentFile,
  revokeConsent,
  signPatientDocument,
  verifyPatientDocumentIntegrity,
  voidPatientDocument,
} from "@/server/services/documents";
import { processOutboxBatch } from "@/server/notifications/outbox";
import { listNotifications } from "@/server/services/notifications";
import { GET as fileRoute } from "@/app/api/v1/patients/[id]/documents/[docId]/file/route";
import { GET as listRoute } from "@/app/api/v1/patients/route";
import {
  apiRequest,
  cleanupTenants,
  createTenant,
  dbError,
  storage,
  type TestTenant,
} from "../support/fixtures";
import { makePng, pngDataUrl } from "../support/png";

/**
 * Sprint 2 — hasta CRM + KVKK + açık rıza + statik imza + değişmez PDF + özel depo.
 * Her şey uygulama rolüyle (kliniva_app); migration rolü yalnızca kurcalama simülasyonu / doğrulama okuması için.
 */
let A: TestTenant;
let B: TestTenant;
let disclosureTpl: string;
let consentTpl: string;

const NAME = "Zeynep";
const SURNAME = "Kılıçarslan";
const PHONE = "0532 765 43 21";
const SIG = () => pngDataUrl(makePng(320, 120));
const CONSENT_KEYS = ["MARKETING_SMS", "MARKETING_EMAIL", "MARKETING_PHONE", "MARKETING_WHATSAPP"] as const;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};

const DISCLOSURE_TEXT =
  "Kişisel verileriniz 6698 sayılı KVKK uyarınca sağlık hizmeti amacıyla işlenir. Sprint 2 metni.";

async function setupTemplates(t: TestTenant) {
  const d = await createTemplateVersion(t.users.owner!.ctx, {
    type: "KVKK_DISCLOSURE",
    name: "Aydınlatma",
    content: DISCLOSURE_TEXT,
    choices: [
      {
        key: "READ_AND_INFORMED",
        label: "Okudum, bilgilendirildim",
        kind: "ACKNOWLEDGEMENT",
        required: true,
      },
    ],
  });
  await publishTemplate(t.users.owner!.ctx, d.id);
  const c = await createTemplateVersion(t.users.owner!.ctx, {
    type: "EXPLICIT_CONSENT",
    name: "Açık Rıza",
    content: "Her iletişim kanalı için ayrı ayrı rıza verebilir veya vermeyebilirsiniz. Sürüm 1.",
    choices: CONSENT_KEYS.map((key) => ({ key, label: key, kind: "CONSENT", required: true })),
  });
  await publishTemplate(t.users.owner!.ctx, c.id);
  return { disclosure: d.id, consent: c.id };
}

async function newPatient(
  t: TestTenant,
  phone = `05${Math.floor(100000000 + Math.random() * 899999999)}`,
  branch = t.branchA,
) {
  return createPatient(t.users.reception!.ctx, {
    firstName: "Hasta",
    lastName: "Test",
    phone,
    branchId: branch,
  });
}

async function signDisclosure(t: TestTenant, patientId: string) {
  const ctx = t.users.reception!.ctx;
  const doc = await createPatientDocument(ctx, { patientId, type: "KVKK_DISCLOSURE" });
  const preview = await presentPatientDocument(ctx, doc.id);
  await signPatientDocument(ctx, doc.id, {
    signedByName: "Hasta Test",
    signerType: "PATIENT",
    signaturePng: SIG(),
    choices: { READ_AND_INFORMED: "READ_AND_INFORMED" },
    expectedContentSha256: preview.contentSha256,
  });
  return doc.id;
}

async function signConsent(t: TestTenant, patientId: string, values: Record<string, "GRANTED" | "DENIED">) {
  const ctx = t.users.reception!.ctx;
  const doc = await createPatientDocument(ctx, { patientId, type: "EXPLICIT_CONSENT" });
  const preview = await presentPatientDocument(ctx, doc.id);
  await signPatientDocument(ctx, doc.id, {
    signedByName: "Hasta Test",
    signerType: "PATIENT",
    signaturePng: SIG(),
    choices: values,
    expectedContentSha256: preview.contentSha256,
  });
  return doc.id;
}

const tenantAudit = (t: TestTenant) =>
  runInTenant(t.id, (s) => s.tx.select().from(auditLogs).where(eq(auditLogs.tenantId, s.tenantId)));

const storageKeysOf = (t: TestTenant, docId: string) =>
  getMigrationDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    const [r] = await tx
      .select({ pdf: patientDocuments.pdfStorageKey, sig: patientDocuments.signatureStorageKey })
      .from(patientDocuments)
      .where(and(eq(patientDocuments.tenantId, t.id), eq(patientDocuments.id, docId)));
    return r!;
  });

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    reception: { role: "RECEPTION" },
    receptionB: { role: "RECEPTION", branch: "B" },
    doctor: { role: "DOCTOR" },
    managerA: { role: "BRANCH_MANAGER", branch: "A" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" }, reception: { role: "RECEPTION" } });
  ({ disclosure: disclosureTpl, consent: consentTpl } = await setupTemplates(A));
  await setupTemplates(B);
}, 120_000);

afterAll(cleanupTenants);

// ------------------------------------------------------------------ 37. Hasta
describe("Hasta CRM", () => {
  it("40 eşzamanlı kayıt → 40 benzersiz, sıralı hasta no (KLI-000001 biçimi)", async () => {
    const created = await Promise.all(
      Array.from({ length: 40 }, (_, i) => newPatient(A, `0533${String(1000000 + i)}`)),
    );
    const numbers = created.map((c) => c.patientNumber);
    expect(new Set(numbers).size).toBe(40);
    for (const n of numbers) expect(n).toMatch(/^KLI-\d{6}$/);
  }, 120_000);

  it("telefon E.164 normalize edilir; farklı yazımla arama bulur", async () => {
    const p = await createPatient(A.users.reception!.ctx, {
      firstName: NAME,
      lastName: SURNAME,
      phone: PHONE,
      email: "Zeynep.K@Example.com",
      branchId: A.branchA,
    });
    const found = await listPatients(A.users.reception!.ctx, { q: "+905327654321" });
    expect(found.items.map((x) => x.id)).toContain(p.id);
    const byEmail = await listPatients(A.users.reception!.ctx, { q: "zeynep.k@example.com" });
    expect(byEmail.items.map((x) => x.id)).toContain(p.id);
  });

  it("mükerrer uyarı: normalize telefon / e-posta eşleşir; birleştirme yapılmaz, kayıt oluşur", async () => {
    const dup = await findPossibleDuplicatePatients(A.users.reception!.ctx, { phone: "+90 532 765 43 21" });
    expect(dup.map((d) => d.matchedOn).flat()).toContain("PHONE");
    const again = await createPatient(A.users.reception!.ctx, {
      firstName: "Başka",
      lastName: "Kişi",
      phone: "05327654321",
      email: "zeynep.k@example.com",
      branchId: A.branchA,
    });
    expect(again.duplicates.length).toBeGreaterThan(0);
    expect(again.patientNumber).toMatch(/^KLI-/);
    const audit = await tenantAudit(A);
    const warn = audit.find((r) => r.action === "PATIENT_DUPLICATE_WARNING" && r.entityId === again.id);
    expect(warn).toBeDefined();
    expect(JSON.stringify(warn)).not.toContain("5327654321");
  });

  it("mükerrer arama kiracı ve şube güvenli: B kiracısı ve B şubesi kullanıcısı A şubesindeki kaydı görmez", async () => {
    expect(await findPossibleDuplicatePatients(B.users.owner!.ctx, { phone: PHONE })).toEqual([]);
    expect(await findPossibleDuplicatePatients(A.users.receptionB!.ctx, { phone: PHONE })).toEqual([]);
  });

  it("liste sayfalama: varsayılan 25, en fazla 100", async () => {
    const r = await listPatients(A.users.owner!.ctx);
    expect(r.limit).toBe(25);
    expect(r.items.length).toBeLessThanOrEqual(25);
    expect(r.total).toBeGreaterThan(25);
    expect((await listPatients(A.users.owner!.ctx, { limit: 5000 })).limit).toBe(100);
    const p2 = await listPatients(A.users.owner!.ctx, { page: 2 });
    expect(p2.items.map((x) => x.id)).not.toEqual(expect.arrayContaining(r.items.map((x) => x.id)));
  });

  it("API listesi telefonu maskeli döner; sağlık / TC kimlik alanı yok", async () => {
    const res = await listRoute(
      apiRequest("/api/v1/patients?q=Kılıçarslan", { token: A.users.reception!.token }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("5327654321");
    expect(body).not.toMatch(/nationalId|notes|health/);
  });

  it("şube kapsamı patient_branches üzerinden: B şubesi resepsiyonu A şubesi hastasını göremez", async () => {
    const p = await newPatient(A);
    expect(await code(getPatient(A.users.receptionB!.ctx, p.id))).toBe("NOT_FOUND");
    expect((await getPatient(A.users.managerA!.ctx, p.id)).branches.map((b) => b.id)).toEqual([A.branchA]);
  });

  it("TC kimlik şifreli saklanır, yalnızca maskeli döner", async () => {
    const p = await createPatient(A.users.reception!.ctx, {
      firstName: "Tc",
      lastName: "Test",
      phone: "05320009988",
      nationalId: "10000000146",
      branchId: A.branchA,
    });
    const d = await getPatient(A.users.reception!.ctx, p.id);
    expect(d.nationalIdMasked).toMatch(/\*+46$/);
    expect(JSON.stringify(d)).not.toContain("10000000146");
    const raw = await getMigrationDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${A.id}, true)`);
      return tx.execute<{ v: string }>(
        sql`select national_id_encrypted as v from kliniva.patients where id = ${p.id}`,
      );
    });
    expect(raw.rows[0]!.v).not.toContain("10000000146");
  });
});

// ------------------------------------------------------------------ 38. Belge + PDF + depo
describe("KVKK belgesi, PDF ve dosya uç noktası", () => {
  let patientId: string;
  let docId: string;

  beforeAll(async () => {
    patientId = (await newPatient(A)).id;
    docId = await signDisclosure(A, patientId);
  });

  it("imzalı belge: SIGNED, imzalayan türü PATIENT, content SHA ve PDF SHA bütünlük doğrulamasından geçer", async () => {
    const d = await getPatientDocument(A.users.reception!.ctx, docId);
    expect(d.status).toBe("SIGNED");
    expect(d.signerType).toBe("PATIENT");
    const v = await verifyPatientDocumentIntegrity(A.users.reception!.ctx, docId);
    expect(v.documentSha256).toBe(d.documentSha256);
    expect(v.contentSha256).toBe(d.contentSha256);
  });

  it("yanıtlarda depolama anahtarı / snapshot yok", async () => {
    const d = await getPatientDocument(A.users.reception!.ctx, docId);
    const list = await listPatientDocuments(A.users.reception!.ctx, patientId);
    for (const blob of [JSON.stringify(d), JSON.stringify(list)]) {
      expect(blob).not.toMatch(/tenant\/[0-9a-f-]{36}\//);
      expect(blob).not.toMatch(/StorageKey|contentSnapshot/);
    }
  });

  it("GET /api/v1/patients/:id/documents/:docId/file → PDF, no-store, nosniff, PII'siz dosya adı", async () => {
    const res = await fileRoute(
      apiRequest(`/api/v1/patients/${patientId}/documents/${docId}/file?download=1`, {
        token: A.users.reception!.token,
      }),
      { params: Promise.resolve({ id: patientId, docId }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const cd = res.headers.get("content-disposition")!;
    expect(cd).toBe(`attachment; filename="kvkk-belgesi-${docId}.pdf"`);
    expect(cd).not.toMatch(/Hasta|Test/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const audit = await tenantAudit(A);
    expect(audit.some((r) => r.action === "PATIENT_DOCUMENT_DOWNLOADED" && r.entityId === docId)).toBe(true);
  });

  it("başka kiracı → 404; başka hastanın yolu → 404; yetkisiz rol → 403; oturumsuz → 401", async () => {
    const call = (token: string | null, pid = patientId) =>
      fileRoute(apiRequest(`/api/v1/patients/${pid}/documents/${docId}/file`, { token }), {
        params: Promise.resolve({ id: pid, docId }),
      });
    expect((await call(B.users.owner!.token)).status).toBe(404);
    const other = await newPatient(A);
    expect((await call(A.users.reception!.token, other.id)).status).toBe(404);
    expect((await call(A.users.receptionB!.token)).status).toBe(404);
    expect((await call(null)).status).toBe(401);
    // Doktor patient.document.read'e sahip → okuyabilir.
    expect((await call(A.users.doctor!.token)).status).toBe(200);
  });

  it("depo kurcalanırsa (aynı anahtara başka geçerli PDF) → DOCUMENT_INTEGRITY_FAILED + audit", async () => {
    const pid = (await newPatient(A)).id;
    const id = await signDisclosure(A, pid);
    const { pdf } = await storageKeysOf(A, id);
    storage.objects.delete(pdf!);
    await storage.put(pdf!, Buffer.from("%PDF-1.7 sahte belge"));
    expect(await code(readDocumentFile(A.users.reception!.ctx, id, "pdf"))).toBe("DOCUMENT_INTEGRITY_FAILED");
    expect(await code(verifyPatientDocumentIntegrity(A.users.reception!.ctx, id))).toBe(
      "DOCUMENT_INTEGRITY_FAILED",
    );
    const fails = (await tenantAudit(A)).filter(
      (r) => r.action === "PATIENT_DOCUMENT_INTEGRITY_FAILED" && r.entityId === id,
    );
    expect(fails.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(fails)).not.toContain("%PDF");
    // Sprint 6: aynı transaction içinde outbox olayı → sahip / yöneticiye bildirim (içerik / hasta adı yok).
    const events = await runInTenant(A.id, (s) =>
      s.tx.execute<{ payload: unknown }>(
        sql`select payload_safe as payload from kliniva.outbox_events where aggregate_id = ${id} and event_type = 'DOCUMENT_INTEGRITY_FAILED'`,
      ),
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(events.rows)).not.toMatch(/%PDF|Hasta|Test/);
    await processOutboxBatch({ tenantIds: [A.id] });
    const owners = await listNotifications(A.users.owner!.ctx, { filter: "security" });
    const alert = owners.items.find((n) => n.type === "DOCUMENT_INTEGRITY_FAILED");
    expect(alert?.body).toBe("Bir hasta belgesinde bütünlük kontrolü başarısız oldu.");
    expect((await listNotifications(A.users.reception!.ctx, { filter: "security" })).items).toEqual([]);
  });

  it("şifreli nesnenin baytları bozulursa (GCM) da bütünlük ihlali — 'yok' sayılmaz", async () => {
    const pid = (await newPatient(A)).id;
    const id = await signDisclosure(A, pid);
    const { pdf } = await storageKeysOf(A, id);
    const blob = Buffer.from(storage.objects.get(pdf!)!);
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    storage.objects.set(pdf!, blob);
    expect(await code(readDocumentFile(A.users.reception!.ctx, id, "pdf"))).toBe("DOCUMENT_INTEGRITY_FAILED");
  });

  it("depodaki PDF baytları DB'deki SHA-256 ile eşleşir ve şifreli saklanır", async () => {
    const { pdf, sig } = await storageKeysOf(A, docId);
    expect(pdf).toMatch(new RegExp(`^tenant/${A.id}/documents/[0-9a-f-]{36}\\.bin$`));
    expect(sig).toMatch(new RegExp(`^tenant/${A.id}/signatures/[0-9a-f-]{36}\\.bin$`));
    const plain = await storage.get(pdf!);
    expect(sha256Hex(plain!)).toBe((await getPatientDocument(A.users.reception!.ctx, docId)).documentSha256);
    expect(storage.objects.get(pdf!)!.subarray(0, 64).toString("latin1")).not.toContain("%PDF");
  });
});

// ------------------------------------------------------------------ 39. İmza / eşzamanlılık / TOCTOU / VOID
describe("İmza akışı güvenliği", () => {
  it("eşzamanlı iki imza → 1 başarılı, 1 DOCUMENT_ALREADY_SIGNED", async () => {
    const pid = (await newPatient(A)).id;
    const ctx = A.users.reception!.ctx;
    const doc = await createPatientDocument(ctx, { patientId: pid, type: "KVKK_DISCLOSURE" });
    const p = await presentPatientDocument(ctx, doc.id);
    const attempt = () =>
      code(
        signPatientDocument(ctx, doc.id, {
          signedByName: "Hasta Test",
          signaturePng: SIG(),
          choices: { READ_AND_INFORMED: "READ_AND_INFORMED" },
          expectedContentSha256: p.contentSha256,
        }),
      );
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.sort()).toEqual(["DOCUMENT_ALREADY_SIGNED", "OK"]);
    const signed = await getPatientDocument(ctx, doc.id);
    expect(signed.choices).toHaveLength(1);
  });

  it("TOCTOU: v1 önizlendi → v2 yayımlandı → imza v1 snapshot'ına bağlı kalır", async () => {
    const pid = (await newPatient(A)).id;
    const ctx = A.users.reception!.ctx;
    const doc = await createPatientDocument(ctx, { patientId: pid, type: "KVKK_DISCLOSURE" });
    const preview = await presentPatientDocument(ctx, doc.id);
    expect(preview.snapshot.content).toBe(DISCLOSURE_TEXT);

    const v2 = await createTemplateVersion(A.users.owner!.ctx, {
      type: "KVKK_DISCLOSURE",
      name: "Aydınlatma v2",
      content: "TAMAMEN FARKLI ikinci sürüm metni — imzalanan belgede GÖRÜNMEMELİ.",
      choices: [{ key: "READ_AND_INFORMED", label: "Okudum", kind: "ACKNOWLEDGEMENT", required: true }],
    });
    await publishTemplate(A.users.owner!.ctx, v2.id);

    expect((await getDocumentPreview(ctx, doc.id)).snapshot.content).toBe(DISCLOSURE_TEXT);
    // Önizlenmeyen bir özetle imza → CONFLICT
    expect(
      await code(
        signPatientDocument(ctx, doc.id, {
          signedByName: "Hasta Test",
          signaturePng: SIG(),
          choices: { READ_AND_INFORMED: "READ_AND_INFORMED" },
          expectedContentSha256: "0".repeat(64),
        }),
      ),
    ).toBe("CONFLICT");
    await signPatientDocument(ctx, doc.id, {
      signedByName: "Hasta Test",
      signaturePng: SIG(),
      choices: { READ_AND_INFORMED: "READ_AND_INFORMED" },
      expectedContentSha256: preview.contentSha256,
    });
    const signed = await getPatientDocument(ctx, doc.id);
    expect(signed.contentSha256).toBe(preview.contentSha256);
    expect(signed.documentTemplateId).toBe(disclosureTpl);

    // Yeni belge artık v2'den
    const next = await createPatientDocument(ctx, { patientId: pid, type: "KVKK_DISCLOSURE" });
    expect((await getDocumentPreview(ctx, next.id)).snapshot.content).toContain("ikinci sürüm");
  });

  it("VOID: yalnızca yetkili rol; gerekçe zorunlu; orijinal hash korunur; PDF hâlâ doğrulanır", async () => {
    const pid = (await newPatient(A)).id;
    const id = await signDisclosure(A, pid);
    const before = await getPatientDocument(A.users.owner!.ctx, id);
    expect(await code(voidPatientDocument(A.users.reception!.ctx, id, "Resepsiyon deniyor"))).toBe(
      "FORBIDDEN",
    );
    expect(await code(voidPatientDocument(A.users.owner!.ctx, id, "x"))).toBe("VALIDATION");
    await voidPatientDocument(A.users.owner!.ctx, id, "Yanlış hastaya imzalatıldı");
    const after = await getPatientDocument(A.users.owner!.ctx, id);
    expect(after.status).toBe("VOIDED");
    expect(after.voidReason).toBe("Yanlış hastaya imzalatıldı");
    expect(after.voidedByUserId).toBe(A.users.owner!.id);
    expect(after.voidedAt).toBeInstanceOf(Date);
    expect(after.documentSha256).toBe(before.documentSha256);
    expect(after.contentSha256).toBe(before.contentSha256);
    await verifyPatientDocumentIntegrity(A.users.owner!.ctx, id);
    expect(await code(voidPatientDocument(A.users.owner!.ctx, id, "İkinci kez geçersiz kıl"))).toBe(
      "CONFLICT",
    );
    expect(
      (await tenantAudit(A)).some((r) => r.action === "PATIENT_DOCUMENT_VOIDED" && r.entityId === id),
    ).toBe(true);
  });

  it("veli / yasal temsilci imzası: yakınlık zorunlu ve kaydedilir", async () => {
    const pid = (await newPatient(A)).id;
    const ctx = A.users.reception!.ctx;
    const doc = await createPatientDocument(ctx, { patientId: pid, type: "KVKK_DISCLOSURE" });
    const base = {
      signedByName: "Veli Test",
      signerType: "PARENT",
      signaturePng: SIG(),
      choices: { READ_AND_INFORMED: "READ_AND_INFORMED" },
    };
    expect(await code(signPatientDocument(ctx, doc.id, base))).toBe("VALIDATION");
    await signPatientDocument(ctx, doc.id, { ...base, guardianRelationship: "Anne" });
    const d = await getPatientDocument(ctx, doc.id);
    expect([d.signerType, d.guardianRelationship]).toEqual(["PARENT", "Anne"]);
  });

  it("RBAC: DOCTOR belge okur ama oluşturamaz / imzalayamaz; RECEPTION oluşturur ve imzalatır", async () => {
    const pid = (await newPatient(A)).id;
    expect(
      await code(createPatientDocument(A.users.doctor!.ctx, { patientId: pid, type: "KVKK_DISCLOSURE" })),
    ).toBe("FORBIDDEN");
    const doc = await createPatientDocument(A.users.reception!.ctx, {
      patientId: pid,
      type: "KVKK_DISCLOSURE",
    });
    expect(
      await code(
        signPatientDocument(A.users.doctor!.ctx, doc.id, {
          signedByName: "X Y",
          signaturePng: SIG(),
          choices: { READ_AND_INFORMED: "READ_AND_INFORMED" },
        }),
      ),
    ).toBe("FORBIDDEN");
    expect((await listPatientDocuments(A.users.doctor!.ctx, pid)).map((d) => d.id)).toContain(doc.id);
  });
});

// ------------------------------------------------------------------ 40. Açık rıza durumu + geri çekme
describe("Açık rıza durumu ve geri çekme", () => {
  let pid: string;
  let consentDoc: string;

  beforeAll(async () => {
    pid = (await newPatient(A)).id;
    await signDisclosure(A, pid);
  });

  it("aydınlatma tek başına → PARTIAL; rıza kararları (tümü DENIED olsa da) → COMPLETE", async () => {
    expect((await getPatient(A.users.reception!.ctx, pid)).privacyStatus).toBe("PARTIAL");
    consentDoc = await signConsent(A, pid, {
      MARKETING_SMS: "GRANTED",
      MARKETING_EMAIL: "DENIED",
      MARKETING_PHONE: "DENIED",
      MARKETING_WHATSAPP: "DENIED",
    });
    expect((await getPatient(A.users.reception!.ctx, pid)).privacyStatus).toBe("COMPLETE");
    const other = (await newPatient(A)).id;
    expect((await getPatient(A.users.reception!.ctx, other)).privacyStatus).toBe("MISSING");
  });

  it("getCurrentConsentState: GRANTED / DENIED / NOT_ASKED (sorulmamış asla GRANTED değil)", async () => {
    const ctx = A.users.reception!.ctx;
    expect(await getCurrentConsentState(ctx, pid, "MARKETING_SMS")).toBe("GRANTED");
    expect(await getCurrentConsentState(ctx, pid, "MARKETING_EMAIL")).toBe("DENIED");
    expect(await getCurrentConsentState(ctx, pid, "MARKETING_FAX")).toBe("NOT_ASKED");
    const fresh = (await newPatient(A)).id;
    for (const k of CONSENT_KEYS) expect(await getCurrentConsentState(ctx, fresh, k)).toBe("NOT_ASKED");
  });

  it("geri çekme → REVOKED; imzalı belge ve seçim DEĞİŞMEZ; DENIED / tekrar geri çekme → CONFLICT", async () => {
    const ctx = A.users.reception!.ctx;
    const before = await getPatientDocument(ctx, consentDoc);
    await revokeConsent(ctx, pid, { key: "MARKETING_SMS", channel: "PHONE", reason: "Hasta aradı" });
    expect(await getCurrentConsentState(ctx, pid, "MARKETING_SMS")).toBe("REVOKED");
    const after = await getPatientDocument(ctx, consentDoc);
    expect(after.documentSha256).toBe(before.documentSha256);
    expect(after.status).toBe("SIGNED");
    expect(after.choices.find((c) => c.key === "MARKETING_SMS")!.value).toBe("GRANTED");
    expect(await code(revokeConsent(ctx, pid, { key: "MARKETING_SMS", channel: "PHONE" }))).toBe("CONFLICT");
    expect(await code(revokeConsent(ctx, pid, { key: "MARKETING_EMAIL", channel: "PHONE" }))).toBe(
      "CONFLICT",
    );
    expect(await code(revokeConsent(ctx, pid, { key: "READ_AND_INFORMED", channel: "PHONE" }))).toBe(
      "CONFLICT",
    );
  });

  it("yeni rıza belgesi geri çekilmiş kanalı tekrar GRANTED yapabilir (en güncel karar geçerli)", async () => {
    await signConsent(A, pid, {
      MARKETING_SMS: "GRANTED",
      MARKETING_EMAIL: "GRANTED",
      MARKETING_PHONE: "DENIED",
      MARKETING_WHATSAPP: "DENIED",
    });
    expect(await getCurrentConsentState(A.users.reception!.ctx, pid, "MARKETING_SMS")).toBe("GRANTED");
    expect(await getCurrentConsentState(A.users.reception!.ctx, pid, "MARKETING_EMAIL")).toBe("GRANTED");
  });

  it("audit: CONSENT_GRANTED / DENIED / REVOKED + belge olayları; içerik ve PII yok", async () => {
    const audit = await tenantAudit(A);
    const actions = new Set(audit.map((r) => r.action));
    for (const a of [
      "PATIENT_CREATED",
      "PATIENT_DOCUMENT_CREATED",
      "PATIENT_DOCUMENT_PRESENTED",
      "PATIENT_DOCUMENT_SIGNED",
      "CONSENT_GRANTED",
      "CONSENT_DENIED",
      "CONSENT_REVOKED",
    ]) {
      expect(actions.has(a as never), a).toBe(true);
    }
    const dump = JSON.stringify(audit);
    for (const secret of [
      DISCLOSURE_TEXT.slice(0, 40),
      "Hasta aradı",
      NAME,
      SURNAME,
      "5327654321",
      "iVBORw0KGgo",
    ]) {
      expect(dump, secret).not.toContain(secret);
    }
  });

  it("DB tetikleyicisi: aydınlatma onayı geri çekilemez (uygulama rolüyle doğrudan INSERT)", async () => {
    const [ack] = await runInTenant(A.id, (s) =>
      s.tx.execute<{ id: string }>(
        sql`select c.id from kliniva.consent_choices c join kliniva.patient_documents d on d.id = c.patient_document_id
            where d.patient_id = ${pid} and c.value = 'READ_AND_INFORMED' limit 1`,
      ),
    ).then((r) => r.rows);
    const err = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.execute(
          sql`insert into kliniva.consent_revocations (tenant_id, patient_id, consent_choice_id, channel)
              values (${A.id}, ${pid}, ${ack!.id}, 'PHONE')`,
        ),
      ),
    );
    expect(err.message).toMatch(/cannot be revoked/);
  });
});

// ------------------------------------------------------------------ 41. DB değişmezlik tetikleyicileri
describe("patient_documents değişmezlik (DB)", () => {
  it("SIGNED → yalnızca VOIDED; kanıt alanları değiştirilemez; PRESENTED → DRAFT yasak", async () => {
    const pid = (await newPatient(A)).id;
    const signedId = await signDisclosure(A, pid);
    const presented = await createPatientDocument(A.users.reception!.ctx, {
      patientId: pid,
      type: "KVKK_DISCLOSURE",
    });
    await presentPatientDocument(A.users.reception!.ctx, presented.id);
    const client = await getPool().connect();
    try {
      for (const [stmt, id] of [
        ["update kliniva.patient_documents set status = 'DRAFT' where id = $1", signedId],
        ["update kliniva.patient_documents set content_sha256 = repeat('0', 64) where id = $1", signedId],
        ["update kliniva.patient_documents set status = 'VOIDED' where id = $1", signedId], // gerekçesiz
        ["update kliniva.patient_documents set status = 'DRAFT' where id = $1", presented.id],
        ["update kliniva.patient_documents set content_snapshot_encrypted = 'x' where id = $1", presented.id],
      ] as const) {
        await client.query("begin");
        await client.query("select set_config('app.tenant_id', $1, true)", [A.id]);
        await expect(client.query(stmt, [id]), stmt).rejects.toThrow(/KLINIVA_/);
        await client.query("rollback");
      }
    } finally {
      client.release();
    }
  });

  it("snapshot'sız / yayımlanmamış şablonla belge eklenemez", async () => {
    const pid = (await newPatient(A)).id;
    const draft = await createTemplateVersion(A.users.owner!.ctx, {
      type: "OTHER",
      name: "Yayımlanmamış",
      content: "Bu şablon yayımlanmadı, hastaya sunulamaz.",
      choices: [],
    });
    expect(
      await code(createPatientDocument(A.users.reception!.ctx, { patientId: pid, templateId: draft.id })),
    ).not.toBe("OK");
    const err = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .execute(sql`insert into kliniva.patient_documents (tenant_id, patient_id, branch_id, document_template_id, document_version)
              values (${A.id}, ${pid}, ${A.branchA}, ${consentTpl}, 1)`),
      ),
    );
    expect(err.message).toMatch(/KLINIVA_/);
  });
});

// ------------------------------------------------------------------ 42. RLS + pooled leak (yeni tablolar)
describe("RLS — patient_branches / consent_revocations", () => {
  const NEW = ["patient_branches", "consent_revocations"] as const;

  it("B bağlamında A satırları görünmez; A kiracı kimliğiyle yazılamaz (42501)", async () => {
    const pid = (await newPatient(A)).id;
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [B.id]);
      for (const t of NEW) {
        expect(
          (await client.query(`select 1 from kliniva.${t} where tenant_id = $1`, [A.id])).rowCount,
          t,
        ).toBe(0);
      }
      await expect(
        client.query(
          "insert into kliniva.patient_branches (tenant_id, patient_id, branch_id) values ($1, $2, $3)",
          [A.id, pid, A.branchB],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("kiracı bağlamı yok → 0 satır", async () => {
    for (const t of NEW)
      expect((await getPool().query(`select 1 from kliniva.${t} limit 1`)).rowCount, t).toBe(0);
  });

  it("POOLED_CONNECTION_TENANT_CONTEXT_LEAK_TEST (Sprint 2 tabloları): A sonrası aynı bağlantıda B, A'yı görmez", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const c1: PoolClient = await pool.connect();
      await c1.query("begin");
      await c1.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      expect(
        (await c1.query("select count(*)::int n from kliniva.patient_branches")).rows[0].n,
      ).toBeGreaterThan(0);
      expect(
        (await c1.query("select count(*)::int n from kliniva.consent_revocations")).rows[0].n,
      ).toBeGreaterThan(0);
      await c1.query("commit");
      c1.release();

      const c2 = await pool.connect();
      expect(c2).toBe(c1);
      expect((await c2.query("select current_setting('app.tenant_id', true) as v")).rows[0]?.v ?? "").toBe(
        "",
      );
      for (const t of NEW) expect((await c2.query(`select 1 from kliniva.${t} limit 1`)).rowCount, t).toBe(0);
      await c2.query("begin");
      await c2.query("select set_config('app.tenant_id', $1, true)", [B.id]);
      for (const t of NEW) {
        const r = await c2.query(`select count(*)::int n from kliniva.${t} where tenant_id = $1`, [A.id]);
        expect(r.rows[0].n, t).toBe(0);
      }
      await c2.query("rollback");
      c2.release();
    } finally {
      await pool.end();
    }
    // Uygulama yolu: dönüşümlü 20 istek, her biri yalnızca kendi kiracısının bağlarını görür.
    const seen = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const ctx = i % 2 ? B.users.owner!.ctx : A.users.owner!.ctx;
        return tenantQuery(ctx, async (scope) => ({
          expected: ctx.tenantId,
          rows: (
            await scope.tx.execute<{ tenant_id: string }>(sql`select tenant_id from kliniva.patient_branches`)
          ).rows,
        }));
      }),
    );
    for (const s of seen) expect(s.rows.every((r) => r.tenant_id === s.expected)).toBe(true);
  });
});
