import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getPool } from "@/server/db/client";
import { getMigrationDb } from "@/server/db/migration-client";
import { documentTemplates, patientDocuments } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runInTenant } from "@/server/tenant/tenant-query";
import { sha256Hex } from "@/server/security/crypto";
import { createPatient } from "@/server/services/patients";
import {
  createTemplateVersion,
  generatePatientDocument,
  getPatientDocument,
  markDocumentPresented,
  publishTemplate,
  readDocumentFile,
  signPatientDocument,
} from "@/server/services/documents";
import { GET as fileRoute } from "@/app/api/v1/documents/[id]/file/route";
import {
  apiRequest,
  cleanupTenants,
  createTenant,
  params,
  storage,
  dbError,
  type TestTenant,
} from "../support/fixtures";
import { makePng, pngDataUrl } from "../support/png";

let T: TestTenant;
let Other: TestTenant;
let patientId: string;
let disclosureV1: string;
let signedDocId: string;
let signedSha: string;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};

const DISCLOSURE = {
  type: "KVKK_DISCLOSURE",
  name: "Hasta Aydınlatma Metni",
  content: "Kişisel verileriniz 6698 sayılı KVKK uyarınca sağlık hizmeti amacıyla işlenir. Versiyon 1 metni.",
  choices: [
    { key: "read_and_informed", label: "Okudum, bilgilendirildim", kind: "ACKNOWLEDGEMENT", required: true },
  ],
};

const signature = () =>
  pngDataUrl(makePng(320, 120, [{ type: "tEXt", data: Buffer.from("pressure\u0000[0.3,0.7]") }]));

beforeAll(async () => {
  T = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    reception: { role: "RECEPTION" },
    readonly: { role: "READ_ONLY" },
  });
  Other = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  patientId = (
    await createPatient(T.users.owner!.ctx, {
      firstName: "Elif",
      lastName: "Şahin",
      phone: "05324440000",
      branchId: T.branchA,
    })
  ).id;
  disclosureV1 = (await createTemplateVersion(T.users.owner!.ctx, DISCLOSURE)).id;
  await publishTemplate(T.users.owner!.ctx, disclosureV1);
});

afterAll(cleanupTenants);

describe("KVKK belge akışı", () => {
  it("üret → sun → imzala: SIGNED, PDF SHA-256 eşleşir, imza statik ve temiz", async () => {
    const reception = T.users.reception!.ctx;
    const { id, documentVersion } = await generatePatientDocument(reception, {
      patientId,
      templateId: disclosureV1,
    });
    expect(documentVersion).toBe(1);
    await markDocumentPresented(reception, id);
    const { documentSha256 } = await signPatientDocument(reception, id, {
      signedByName: "Elif Şahin",
      signaturePng: signature(),
      choices: { read_and_informed: "READ_AND_INFORMED" },
    });
    signedDocId = id;
    signedSha = documentSha256;

    const doc = await getPatientDocument(reception, id);
    expect(doc.status).toBe("SIGNED");
    expect(doc.documentSha256).toBe(documentSha256);
    expect(doc.choices).toEqual([
      expect.objectContaining({ key: "read_and_informed", value: "READ_AND_INFORMED" }),
    ]);
    // Depolama anahtarları istemciye dönmez.
    expect(JSON.stringify(doc)).not.toMatch(/signatures\/|pdfs\//);

    const pdf = await readDocumentFile(reception, id, "pdf");
    expect(pdf.data.subarray(0, 5).toString()).toBe("%PDF-");
    expect(sha256Hex(pdf.data)).toBe(documentSha256);
    expect(pdf.sha256Ok).toBe(true);

    const sig = await readDocumentFile(reception, id, "signature");
    expect(sig.data.toString("latin1")).not.toContain("pressure");
    expect(sig.data.toString("latin1")).not.toContain("tEXt");
  });

  it("depoda imza ve PDF şifreli (düz PNG/PDF baytı yok)", () => {
    for (const blob of storage.objects.values()) {
      expect(blob.subarray(0, 64).toString("latin1")).not.toContain("PNG");
      expect(blob.subarray(0, 64).toString("latin1")).not.toContain("%PDF");
    }
  });

  it("aydınlatma belgesine CONSENT_GRANTED kaydedilemez (servis + veritabanı)", async () => {
    const { id } = await generatePatientDocument(T.users.owner!.ctx, { patientId, templateId: disclosureV1 });
    expect(
      await code(
        signPatientDocument(T.users.owner!.ctx, id, {
          signedByName: "Elif Şahin",
          signaturePng: signature(),
          choices: { read_and_informed: "GRANTED" },
        }),
      ),
    ).toBe("VALIDATION");
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [T.id]);
      await expect(
        client.query(
          "insert into kliniva.consent_choices (tenant_id, patient_document_id, key, value) values ($1, $2, 'read_and_informed', 'GRANTED')",
          [T.id, id],
        ),
      ).rejects.toThrow(/READ_AND_INFORMED/);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});

describe("İmzalanmış PatientDocument overwrite edilemez", () => {
  it("ikinci imza denemesi → CONFLICT", async () => {
    expect(
      await code(
        signPatientDocument(T.users.owner!.ctx, signedDocId, {
          signedByName: "Başka Biri",
          signaturePng: signature(),
          choices: { read_and_informed: "READ_AND_INFORMED" },
        }),
      ),
    ).toBe("CONFLICT");
  });

  it("uygulama rolü (kliniva_app): UPDATE tetikleyiciyle, DELETE ve seçim değişikliği yetkiyle reddedilir", async () => {
    const client = await getPool().connect();
    try {
      const cases: [string, RegExp | { code: string }][] = [
        ["update kliniva.patient_documents set signed_by_name = 'Sahte' where id = $1", /KLINIVA_IMMUTABLE/],
        ["update kliniva.patient_documents set document_sha256 = 'x' where id = $1", /KLINIVA_IMMUTABLE/],
        ["update kliniva.patient_documents set document_version = 99 where id = $1", /KLINIVA_IMMUTABLE/],
        ["update kliniva.patient_documents set pdf_storage_key = null where id = $1", /KLINIVA_IMMUTABLE/],
        ["update kliniva.patient_documents set status = 'VOIDED' where id = $1", /KLINIVA_IMMUTABLE/],
        ["delete from kliniva.patient_documents where id = $1", { code: "42501" }],
        [
          "update kliniva.consent_choices set value = 'READ_AND_INFORMED' where patient_document_id = $1",
          { code: "42501" },
        ],
        ["delete from kliniva.consent_choices where patient_document_id = $1", { code: "42501" }],
        [
          "insert into kliniva.consent_choices (tenant_id, patient_document_id, key, value) select tenant_id, id, 'extra', 'READ_AND_INFORMED' from kliniva.patient_documents where id = $1",
          /KLINIVA_IMMUTABLE/,
        ],
      ];
      for (const [stmt, expected] of cases) {
        await client.query("begin");
        await client.query("select set_config('app.tenant_id', $1, true)", [T.id]);
        if (expected instanceof RegExp)
          await expect(client.query(stmt, [signedDocId]), stmt).rejects.toThrow(expected);
        else await expect(client.query(stmt, [signedDocId]), stmt).rejects.toMatchObject(expected);
        await client.query("rollback");
      }
    } finally {
      client.release();
    }
  });

  it("migration (sahip) rolü bile imha bağlamı olmadan imzalı belgeyi/seçimleri değiştiremez veya silemez", async () => {
    for (const stmt of [
      sql`update kliniva.patient_documents set signed_by_name = 'Sahte' where id = ${signedDocId}`,
      sql`delete from kliniva.patient_documents where id = ${signedDocId}`,
      sql`update kliniva.consent_choices set value = 'READ_AND_INFORMED' where patient_document_id = ${signedDocId}`,
      sql`delete from kliniva.consent_choices where patient_document_id = ${signedDocId}`,
    ]) {
      const err = await dbError(
        getMigrationDb().transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${T.id}, true)`);
          await tx.execute(stmt);
        }),
      );
      expect(err.message).toMatch(/KLINIVA_IMMUTABLE/);
    }
  });

  it("hasta veya kiracı silinse bile imzalı belge CASCADE ile kaybolmaz (FK NO ACTION)", async () => {
    const fk = await getPool().query(`
      select conname, confdeltype from pg_constraint
       where conrelid = 'kliniva.patient_documents'::regclass and contype = 'f' order by conname`);
    // a = NO ACTION, r = RESTRICT, c = CASCADE
    for (const row of fk.rows) expect(row.confdeltype, row.conname).not.toBe("c");
    const attempt = (stmt: ReturnType<typeof sql>, purge: boolean) =>
      dbError(
        getMigrationDb().transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${T.id}, true)`);
          if (purge) await tx.execute(sql`select set_config('kliniva.retention_purge', 'on', true)`);
          await tx.execute(stmt);
        }),
      );
    // Hasta silme → FK (NO ACTION) imzalı belge nedeniyle reddeder.
    const patientDelete = sql`delete from kliniva.patients where id = (select patient_id from kliniva.patient_documents where id = ${signedDocId})`;
    expect((await attempt(patientDelete, false)).code).toBe("23503");
    // Kiracı silme → normalde önce audit tetikleyicisi (P0001) durdurur.
    const tenantDelete = sql`delete from kliniva.tenants where id = ${T.id}`;
    const normal = await attempt(tenantDelete, false);
    expect(normal.code).toBe("P0001");
    expect(normal.message).toMatch(/KLINIVA_IMMUTABLE/);
    // İmha bağlamı açıkken bile (tetikleyiciler izin verir) kiracı→hasta CASCADE, imzalı belge FK'sine takılır:
    // imzalı belge açıkça imha edilmeden hiçbir kaskad onu silemez.
    const purged = await attempt(tenantDelete, true);
    expect(purged.code).toBe("23503");
    const still = await getPatientDocument(T.users.owner!.ctx, signedDocId);
    expect(still.status).toBe("SIGNED");
  });

  it("depodaki imzalı PDF'in üzerine yazılamaz", async () => {
    const [doc] = await runInTenant(T.id, (s) =>
      s.tx
        .select()
        .from(patientDocuments)
        .where(and(eq(patientDocuments.tenantId, s.tenantId), eq(patientDocuments.id, signedDocId))),
    );
    await expect(storage.put(doc!.pdfStorageKey!, Buffer.from("sahte"))).rejects.toThrow();
  });
});

describe("Belge versiyonu değiştiğinde eski imzalı belge korunur", () => {
  it("yayımlanmış şablon metni yerinde değiştirilemez", async () => {
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [T.id]);
      await expect(
        client.query("update kliniva.document_templates set content = 'yeni metin' where id = $1", [
          disclosureV1,
        ]),
      ).rejects.toThrow(/create a new version/);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("yeni metin → v2; eski imzalı belge v1'e bağlı, özeti ve PDF'i değişmeden kalır", async () => {
    const owner = T.users.owner!.ctx;
    const v2 = await createTemplateVersion(owner, {
      ...DISCLOSURE,
      content: `${DISCLOSURE.content} Versiyon 2 ek paragrafı.`,
    });
    expect(v2.version).toBe(2);
    await publishTemplate(owner, v2.id);

    const old = await getPatientDocument(owner, signedDocId);
    expect(old.documentVersion).toBe(1);
    expect(old.documentTemplateId).toBe(disclosureV1);
    expect(old.documentSha256).toBe(signedSha);
    const pdf = await readDocumentFile(owner, signedDocId, "pdf");
    expect(sha256Hex(pdf.data)).toBe(signedSha);

    const [v1Row] = await runInTenant(T.id, (s) =>
      s.tx.select().from(documentTemplates).where(eq(documentTemplates.id, disclosureV1)),
    );
    expect(v1Row!.content).toBe(DISCLOSURE.content); // v1 metni aynen korunur
    expect(v1Row!.active).toBe(false);

    // Pasif (eski) versiyondan yeni belge üretilemez; yeni belge v2 ile üretilir.
    expect(await code(generatePatientDocument(owner, { patientId, templateId: disclosureV1 }))).toBe(
      "NOT_FOUND",
    );
    expect((await generatePatientDocument(owner, { patientId, templateId: v2.id })).documentVersion).toBe(2);
  });
});

describe("İmza / PDF erişimi yalnızca yetkili kullanıcıya", () => {
  it("document.read yetkisi olmayan → FORBIDDEN; başka kiracı → NOT_FOUND", async () => {
    expect(await code(readDocumentFile(T.users.readonly!.ctx, signedDocId, "signature"))).toBe("FORBIDDEN");
    expect(await code(readDocumentFile(Other.users.owner!.ctx, signedDocId, "pdf"))).toBe("NOT_FOUND");
  });

  it("API: oturumsuz 401, yetkili 200 + no-store", async () => {
    expect(
      (await fileRoute(apiRequest(`/api/v1/documents/${signedDocId}/file?kind=pdf`), params(signedDocId)))
        .status,
    ).toBe(401);
    const res = await fileRoute(
      apiRequest(`/api/v1/documents/${signedDocId}/file?kind=signature`, { token: T.users.reception!.token }),
      params(signedDocId),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
