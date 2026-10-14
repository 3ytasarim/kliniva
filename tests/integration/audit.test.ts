import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getPool } from "@/server/db/client";
import { getMigrationDb } from "@/server/db/migration-client";
import { auditLogs } from "@/server/db/schema";
import { runInTenant } from "@/server/tenant/tenant-query";
import { setLogSink } from "@/server/log/logger";
import { createPatient, getPatient, updatePatient } from "@/server/services/patients";
import { setUserRoles } from "@/server/services/users";
import { startMfaEnrollment } from "@/server/services/mfa";
import { login } from "@/server/auth/login";
import { users } from "@/server/db/schema";
import { and, sql } from "drizzle-orm";
import {
  createTemplateVersion,
  generatePatientDocument,
  getPatientDocument,
  publishTemplate,
  readDocumentFile,
  signPatientDocument,
} from "@/server/services/documents";
import {
  cleanupTenants,
  createTenant,
  dbError,
  freshMeta,
  TEST_PASSWORD,
  type TestTenant,
} from "../support/fixtures";
import { makePng, pngDataUrl } from "../support/png";

let T: TestTenant;
let patientId: string;
const SECRET_NOTE = "Onkoloji: kemoterapi protokolü-7731";
const NAME = "Zeynepxyz";
const SURNAME = "Gizlisoyadı";
const PHONE = "05329998877";
const EMAIL = "zeynep.gizli@example.com";
const logs: string[] = [];
let restoreSink: () => void;
const WRONG_PASSWORD = "Yanlis-Parola-Audit-991";
const SIGNATURE = pngDataUrl(makePng(300, 100));
let mfaSecret = "";
let passwordHashPrefix = "";

beforeAll(async () => {
  restoreSink = setLogSink((l) => logs.push(l));
  T = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    doctor: { role: "DOCTOR" },
    reception: { role: "RECEPTION" },
  });
  patientId = (
    await createPatient(T.users.doctor!.ctx, {
      firstName: NAME,
      lastName: SURNAME,
      phone: PHONE,
      email: EMAIL,
      branchId: T.branchA,
      notes: SECRET_NOTE,
    })
  ).id;
  await getPatient(T.users.doctor!.ctx, patientId);
  await getPatient(T.users.reception!.ctx, patientId);
  await updatePatient(T.users.doctor!.ctx, patientId, {
    notes: `${SECRET_NOTE} — güncellendi`,
    phone: "05320001122",
  });

  // LOGIN_SUCCESS / LOGIN_FAILED
  await login({ tenantSlug: T.slug, email: T.users.doctor!.email, password: TEST_PASSWORD }, freshMeta());
  await login({ tenantSlug: T.slug, email: T.users.doctor!.email, password: WRONG_PASSWORD }, freshMeta());
  // PERMISSION_CHANGED
  await setUserRoles(T.users.owner!.ctx, T.users.reception!.id, [
    { roleKey: "RECEPTION", branchId: T.branchA },
  ]);
  // MFA sırrı (audit'e girmemeli)
  mfaSecret = (await startMfaEnrollment(T.users.doctor!.ctx)).secret;
  // KVKK belge: PATIENT_DOCUMENT_SIGNED / PATIENT_DOCUMENT_VIEWED
  const tpl = await createTemplateVersion(T.users.owner!.ctx, {
    type: "KVKK_DISCLOSURE",
    name: "Aydınlatma",
    content: "Kişisel verileriniz KVKK kapsamında işlenir. Audit testi metni.",
    choices: [{ key: "read_and_informed", label: "Okudum", kind: "ACKNOWLEDGEMENT", required: true }],
  });
  await publishTemplate(T.users.owner!.ctx, tpl.id);
  const doc = await generatePatientDocument(T.users.doctor!.ctx, { patientId, templateId: tpl.id });
  await signPatientDocument(T.users.doctor!.ctx, doc.id, {
    signedByName: `${NAME} ${SURNAME}`,
    signaturePng: SIGNATURE,
    choices: { read_and_informed: "READ_AND_INFORMED" },
  });
  await getPatientDocument(T.users.doctor!.ctx, doc.id);
  await readDocumentFile(T.users.doctor!.ctx, doc.id, "pdf");

  const [u] = await runInTenant(T.id, (s) =>
    s.tx
      .select({ h: users.passwordHash })
      .from(users)
      .where(and(eq(users.tenantId, s.tenantId), eq(users.id, T.users.doctor!.id))),
  );
  passwordHashPrefix = u!.h.slice(0, 40);
});

afterAll(async () => {
  restoreSink();
  await cleanupTenants();
});

const tenantAudit = () =>
  runInTenant(T.id, (s) => s.tx.select().from(auditLogs).where(eq(auditLogs.tenantId, s.tenantId)));

describe("Audit log", () => {
  it("gerekli olaylar kaydedilir", async () => {
    const actions = new Set((await tenantAudit()).map((r) => r.action));
    for (const a of [
      "PATIENT_VIEWED",
      "PATIENT_CREATED",
      "PATIENT_UPDATED",
      "PATIENT_DOCUMENT_VIEWED",
      "PATIENT_DOCUMENT_SIGNED",
      "LOGIN_SUCCESS",
      "LOGIN_FAILED",
      "PERMISSION_CHANGED",
    ]) {
      expect(actions.has(a as never), a).toBe(true);
    }
  });

  it("audit kayıtlarında parola, hash, token, MFA sırrı, anahtar, bağlantı dizesi, imza/PDF baytı YOK", async () => {
    const dump = JSON.stringify(await tenantAudit());
    const forbidden: [string, string][] = [
      ["tıbbi not", SECRET_NOTE],
      ["parola", TEST_PASSWORD],
      ["yanlış parola", WRONG_PASSWORD],
      ["parola hash", passwordHashPrefix],
      ["argon2 imzası", "$argon2id$"],
      ["oturum token", T.users.owner!.token],
      ["oturum token", T.users.doctor!.token],
      ["MFA sırrı", mfaSecret],
      ["şifreleme anahtarı", process.env.APP_ENCRYPTION_KEY!],
      ["DATABASE_URL", process.env.DATABASE_URL!],
      ["MIGRATION_DATABASE_URL", process.env.MIGRATION_DATABASE_URL!],
      ["imza baytı (base64)", SIGNATURE.slice(22, 80)],
      ["PNG başlığı", "iVBORw0KGgo"],
      ["PDF içeriği", "%PDF"],
    ];
    for (const [label, value] of forbidden) {
      expect(value.length, label).toBeGreaterThan(3);
      expect(dump.includes(value), label).toBe(false);
    }
    // Şifreli alan biçimi (v1.<iv>.<tag>.<ct>) audit'e hiç girmemeli.
    expect(dump, "şifreli payload").not.toMatch(/v1.[A-Za-z0-9_-]{16}.[A-Za-z0-9_-]{22}./);
  });

  it("hasta hareketleri audit'lenir (CREATED / VIEWED / HEALTH_VIEWED / UPDATED)", async () => {
    const actions = (await tenantAudit()).filter((r) => r.entityId === patientId).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "PATIENT_CREATED",
        "PATIENT_HEALTH_VIEWED",
        "PATIENT_VIEWED",
        "PATIENT_UPDATED",
      ]),
    );
  });

  it("audit kayıtları hasta içeriğini SIZDIRMAZ (not, ad, telefon, e-posta)", async () => {
    const dump = JSON.stringify(await tenantAudit());
    for (const secret of [SECRET_NOTE, "kemoterapi", NAME, SURNAME, PHONE, "05320001122", EMAIL]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("güncelleme kaydı yalnızca alan ADLARINI ve sağlık bayrağını içerir", async () => {
    const upd = (await tenantAudit()).find((r) => r.action === "PATIENT_UPDATED");
    // Not alanı "fields" içinde değil, ayrı bayrakla işaretlenir.
    expect(upd?.metadataSafe).toEqual({ fields: "phone", healthNotesChanged: true });
  });

  it("kaynak (source) ve kullanıcı kaydedilir; IP düz metin değil özet", async () => {
    const created = (await tenantAudit()).find((r) => r.action === "PATIENT_CREATED");
    expect(created?.source).toBe("USER");
    expect(created?.userId).toBe(T.users.doctor!.id);
    expect(created?.ipHash ?? "").not.toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it("uygulama log'ları da hasta içeriği / parola içermez", () => {
    const dump = logs.join("\n");
    for (const secret of [SECRET_NOTE, NAME, PHONE, EMAIL]) expect(dump).not.toContain(secret);
  });

  it("audit_logs yalnızca eklenir: uygulama rolü yetkisiz (42501), sahip rol bile tetikleyiciyle engelli", async () => {
    // Katman 1 — uygulama rolü (kliniva_app): UPDATE/DELETE yetkisi hiç yok.
    const client = await getPool().connect();
    try {
      for (const stmt of [
        "update kliniva.audit_logs set action = 'X' where tenant_id = $1",
        "delete from kliniva.audit_logs where tenant_id = $1",
      ]) {
        await client.query("begin");
        await client.query("select set_config('app.tenant_id', $1, true)", [T.id]);
        await expect(client.query(stmt, [T.id]), stmt).rejects.toMatchObject({ code: "42501" });
        await client.query("rollback");
      }
    } finally {
      client.release();
    }
    // Katman 2 — sahip (migration) rolü: tetikleyici UPDATE'i her zaman, DELETE'i imha bağlamı dışında reddeder.
    for (const [stmt, re] of [
      [sql`update kliniva.audit_logs set action = 'X' where tenant_id = ${T.id}`, /append-only/],
      [sql`delete from kliniva.audit_logs where tenant_id = ${T.id}`, /retention purge/],
    ] as const) {
      const err = await dbError(
        getMigrationDb().transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${T.id}, true)`);
          await tx.execute(stmt);
        }),
      );
      expect(err.message).toMatch(re);
    }
  });
});
