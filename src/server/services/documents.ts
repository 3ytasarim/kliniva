import "server-only";
import {
  DOCUMENT_TYPES,
  type DocumentPreview,
  type DocumentSnapshot,
  type DocumentType,
} from "@/types/patients";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  branches,
  clinicProfiles,
  consentChoices,
  consentRevocations,
  documentTemplates,
  patientDocuments,
  patients,
  tenants,
  type TemplateChoice,
} from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import {
  actorOf,
  canAccessBranch,
  hasPermission,
  requireBranchAccess,
  requirePermission,
  type AuthContext,
} from "@/server/auth/authz";
import { decryptField, encryptField, sha256Hex } from "@/server/security/crypto";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { getPrivateStorage, keyBelongsToTenant, newStorageKey } from "@/server/storage/private-storage";
import {
  decodeSignatureDataUrl,
  InvalidSignatureError,
  sanitizeSignaturePng,
} from "@/server/documents/signature";
import {
  canonicalJson,
  documentTitleOf,
  renderSignedDocumentPdf,
  type SignedDocumentEvidence,
} from "@/server/documents/pdf";
import { clinicBrandingForScope } from "@/server/services/clinic";
import { loadVisiblePatient, touchPatientBranch } from "@/server/services/patients";
import { uuidSchema } from "@/server/validation";
import { parseInput } from "@/server/services/parse";

/**
 * KVKK belge mimarisi.
 *
 *   DocumentTemplate (versiyonlu, yayımlanınca değişmez)
 *        └─ PatientDocument  DRAFT ──present──▶ PRESENTED ──sign──▶ SIGNED ──void──▶ VOIDED
 *               │             (içerik snapshot'ı DRAFT anında ŞİFRELİ olarak sabitlenir; bir daha değişmez)
 *               └─ ConsentChoice (her seçim ayrı satır; imzadan sonra değişmez)
 *                      └─ ConsentRevocation (geri çekme: orijinal seçim değişmez, güncel durum türetilir)
 *
 * TOCTOU: önizlenen ve imzalanan içerik AYNI snapshot'tır (aynı belge kaydı). İstemci önizlediği contentSha256'yı
 * imzada geri gönderir; farklıysa imza reddedilir. Arada yeni şablon versiyonu yayımlansa bile belge v1 kalır.
 *
 * Aydınlatma (KVKK_DISCLOSURE) yalnızca READ_AND_INFORMED alır (rıza değildir, geri çekilemez). Açık rıza
 * tercihleri ayrı ayrı GRANTED / DENIED'dır; DENIED geçerli bir karardır ve hiçbir hizmeti engellemez.
 * Kurallar hem burada hem veritabanı tetikleyicilerinde uygulanır.
 */
/** Paylaşılan tipler @/types/patients içinde (istemci bileşenleri sunucu modülü import edemez). */
export { DOCUMENT_TYPES };
export type { DocumentPreview, DocumentSnapshot, DocumentType };

const CONSENT_TYPES: DocumentType[] = [
  "EXPLICIT_CONSENT",
  "COMMERCIAL_COMMUNICATION_CONSENT",
  "TREATMENT_CONSENT",
];

const templateChoiceSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(300),
  kind: z.enum(["ACKNOWLEDGEMENT", "CONSENT"]),
  required: z.boolean(),
});

export const templateVersionSchema = z
  .object({
    type: z.enum(DOCUMENT_TYPES),
    name: z.string().trim().min(1).max(200),
    content: z.string().trim().min(20).max(50_000),
    choices: z.array(templateChoiceSchema).max(20),
  })
  .superRefine((t, c) => {
    const keys = new Set<string>();
    for (const ch of t.choices) {
      if (keys.has(ch.key)) c.addIssue({ code: "custom", path: ["choices"], message: "duplicate key" });
      keys.add(ch.key);
    }
    if (t.type === "KVKK_DISCLOSURE" && t.choices.some((ch) => ch.kind !== "ACKNOWLEDGEMENT")) {
      c.addIssue({ code: "custom", path: ["choices"], message: "disclosure cannot ask for consent" });
    }
    if (t.type === "EXPLICIT_CONSENT" && !t.choices.some((ch) => ch.kind === "CONSENT")) {
      c.addIssue({ code: "custom", path: ["choices"], message: "explicit consent needs a consent choice" });
    }
  });

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const signDocumentSchema = z
  .object({
    signedByName: z.string().trim().min(2).max(150),
    signerType: z.preprocess(blank, z.enum(["PATIENT", "PARENT", "LEGAL_GUARDIAN"]).optional()),
    guardianRelationship: z.preprocess(blank, z.string().trim().min(2).max(80).optional()),
    /** Eski alan (Sprint 0): yasal temsilci adı. */
    guardianName: z.preprocess(blank, z.string().trim().min(2).max(150).optional()),
    signaturePng: z.string().min(20).max(450_000),
    choices: z.record(z.string(), z.enum(["READ_AND_INFORMED", "GRANTED", "DENIED"])),
    /** Önizlenen snapshot'ın SHA-256'sı (TOCTOU koruması). */
    expectedContentSha256: z.preprocess(
      blank,
      z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    ),
  })
  // Yasal temsilci / veli imzasında yakınlık ZORUNLU (yaş kuralı kodlanmaz; karar personelde, kayıt eksiksiz olmalı).
  .refine((d) => !d.signerType || d.signerType === "PATIENT" || Boolean(d.guardianRelationship), {
    path: ["guardianRelationship"],
  });

const snapshotAad = (tenantId: string, documentId: string) =>
  `patient_document.snapshot:${tenantId}:${documentId}`;
export const snapshotSha256 = (s: DocumentSnapshot) => sha256Hex(`kliniva-snapshot-v1:${canonicalJson(s)}`);

function parseId(raw: unknown): string {
  const id = uuidSchema.safeParse(raw);
  if (!id.success) throw new AppError("NOT_FOUND");
  return id.data;
}

// ---------------------------------------------------------------- şablonlar

export async function listTemplates(ctx: AuthContext) {
  if (!hasPermission(ctx, "document.template.manage")) requirePermission(ctx, "patient.document.read");
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select({
        id: documentTemplates.id,
        tenantId: documentTemplates.tenantId,
        type: documentTemplates.type,
        name: documentTemplates.name,
        version: documentTemplates.version,
        active: documentTemplates.active,
        publishedAt: documentTemplates.publishedAt,
        createdAt: documentTemplates.createdAt,
      })
      .from(documentTemplates)
      // RLS platform (NULL) + kendi kiracı satırlarını gösterir; açık filtre de aynı kuralı uygular.
      .where(or(isNull(documentTemplates.tenantId), eq(documentTemplates.tenantId, scope.tenantId)))
      .orderBy(documentTemplates.type, desc(documentTemplates.version)),
  );
}

export async function getTemplate(ctx: AuthContext, rawId: unknown) {
  if (!hasPermission(ctx, "document.template.manage")) requirePermission(ctx, "patient.document.read");
  const id = parseId(rawId);
  return tenantQuery(ctx, async (scope) => {
    const [tpl] = await scope.tx
      .select()
      .from(documentTemplates)
      .where(
        and(
          eq(documentTemplates.id, id),
          or(isNull(documentTemplates.tenantId), eq(documentTemplates.tenantId, scope.tenantId)),
        ),
      );
    if (!tpl) throw new AppError("NOT_FOUND");
    return tpl;
  });
}

/** Yeni metin = yeni VERSİYON. Mevcut (özellikle yayımlanmış) şablon asla yerinde değiştirilmez. */
export async function createTemplateVersion(
  ctx: AuthContext,
  input: unknown,
): Promise<{ id: string; version: number }> {
  requirePermission(ctx, "document.template.manage");
  const data = parseInput(templateVersionSchema, input);
  return tenantQuery(ctx, async (scope) => {
    const [latest] = await scope.tx
      .select({ version: documentTemplates.version })
      .from(documentTemplates)
      .where(tenantWhere(documentTemplates, scope, eq(documentTemplates.type, data.type)))
      .orderBy(desc(documentTemplates.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    const [row] = await scope.tx
      .insert(documentTemplates)
      .values({ ...data, tenantId: scope.tenantId, version, createdByUserId: ctx.userId })
      .returning({ id: documentTemplates.id });
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCUMENT_TEMPLATE_VERSION_CREATED",
      entityType: "document_template",
      entityId: row!.id,
      metadata: { type: data.type, version },
    });
    return { id: row!.id, version };
  });
}

/** Yayımlar; aynı tipteki eski versiyonlar pasifleşir (ama silinmez — imzalı belgeler snapshot taşır). */
export async function publishTemplate(ctx: AuthContext, rawId: unknown): Promise<void> {
  requirePermission(ctx, "document.template.manage");
  const id = parseId(rawId);
  await tenantQuery(ctx, async (scope) => {
    const [tpl] = await scope.tx
      .select()
      .from(documentTemplates)
      .where(tenantWhere(documentTemplates, scope, eq(documentTemplates.id, id)));
    if (!tpl) throw new AppError("NOT_FOUND");
    if (tpl.publishedAt) throw new AppError("CONFLICT");
    await scope.tx
      .update(documentTemplates)
      .set({ active: false })
      .where(tenantWhere(documentTemplates, scope, eq(documentTemplates.type, tpl.type)));
    await scope.tx
      .update(documentTemplates)
      .set({ publishedAt: new Date(), active: true })
      .where(tenantWhere(documentTemplates, scope, eq(documentTemplates.id, tpl.id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCUMENT_TEMPLATE_PUBLISHED",
      entityType: "document_template",
      entityId: tpl.id,
      metadata: { type: tpl.type, version: tpl.version },
    });
  });
}

/** Tipin güncel (yayımlanmış + aktif) şablonu: önce kiracının kendi şablonu, yoksa platform varsayılanı. */
async function resolveActiveTemplate(scope: TenantScope, type: DocumentType) {
  const rows = await scope.tx
    .select()
    .from(documentTemplates)
    .where(
      and(
        eq(documentTemplates.type, type),
        eq(documentTemplates.active, true),
        sql`${documentTemplates.publishedAt} is not null`,
        or(isNull(documentTemplates.tenantId), eq(documentTemplates.tenantId, scope.tenantId)),
      ),
    )
    .orderBy(desc(documentTemplates.version));
  return rows.find((r) => r.tenantId === scope.tenantId) ?? rows.find((r) => r.tenantId === null) ?? null;
}

// ---------------------------------------------------------------- hasta belgeleri: oluştur / sun

async function loadAccessibleDocument(
  scope: TenantScope,
  ctx: AuthContext,
  rawId: unknown,
  opts: { forUpdate?: boolean } = {},
) {
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  const q = scope.tx
    .select()
    .from(patientDocuments)
    .where(tenantWhere(patientDocuments, scope, eq(patientDocuments.id, id.data)));
  const [doc] = opts.forUpdate ? await q.for("update") : await q;
  if (!doc || !canAccessBranch(ctx, doc.branchId)) throw new AppError("NOT_FOUND");
  // Hasta da kullanıcının kapsamında olmalı (patient_branches).
  await loadVisiblePatient(scope, ctx, doc.patientId);
  return doc;
}

function readSnapshot(
  scope: TenantScope,
  doc: { id: string; contentSnapshotEncrypted: string | null; contentSha256: string | null },
): DocumentSnapshot {
  if (!doc.contentSnapshotEncrypted || !doc.contentSha256) throw new AppError("DOCUMENT_INTEGRITY_FAILED");
  const snap = JSON.parse(
    decryptField(doc.contentSnapshotEncrypted, snapshotAad(scope.tenantId, doc.id)),
  ) as DocumentSnapshot;
  if (snapshotSha256(snap) !== doc.contentSha256) throw new AppError("DOCUMENT_INTEGRITY_FAILED");
  return snap;
}

export const createDocumentSchema = z.object({
  patientId: uuidSchema,
  templateId: z.preprocess(blank, uuidSchema.optional()),
  type: z.preprocess(blank, z.enum(DOCUMENT_TYPES).optional()),
  branchId: z.preprocess(blank, uuidSchema.optional()),
});

/**
 * Hastaya belge oluşturur (DRAFT). Güncel şablon versiyonunun TAM içeriği bu anda şifreli snapshot olarak
 * sabitlenir; sonraki şablon değişikliklerinden etkilenmez.
 */
export async function createPatientDocument(
  ctx: AuthContext,
  input: unknown,
): Promise<{ id: string; documentVersion: number; contentSha256: string; type: DocumentType }> {
  requirePermission(ctx, "patient.document.create");
  const data = parseInput(createDocumentSchema, input);
  if (!data.templateId && !data.type) throw new AppError("VALIDATION", { fields: ["type"] });
  return tenantQuery(ctx, async (scope) => {
    const patient = await loadVisiblePatient(scope, ctx, data.patientId);
    const branchId = data.branchId ?? patient.primaryBranchId;
    if (!branchId)
      throw new AppError("VALIDATION", { fields: ["branchId"], message: "Belge için şube seçin." });
    requireBranchAccess(ctx, branchId);
    const [branch] = await scope.tx
      .select({ id: branches.id })
      .from(branches)
      .where(tenantWhere(branches, scope, eq(branches.id, branchId)));
    if (!branch) throw new AppError("NOT_FOUND");

    let tpl;
    if (data.templateId) {
      [tpl] = await scope.tx
        .select()
        .from(documentTemplates)
        .where(
          and(
            eq(documentTemplates.id, data.templateId),
            or(isNull(documentTemplates.tenantId), eq(documentTemplates.tenantId, scope.tenantId)),
          ),
        );
    } else {
      tpl = await resolveActiveTemplate(scope, data.type!);
    }
    if (!tpl || !tpl.publishedAt || !tpl.active) throw new AppError("NOT_FOUND");

    const id = randomUUID();
    const snapshot: DocumentSnapshot = {
      templateId: tpl.id,
      type: tpl.type,
      title: documentTitleOf(tpl.type),
      name: tpl.name,
      version: tpl.version,
      content: tpl.content,
      choices: tpl.choices,
    };
    const contentSha256 = snapshotSha256(snapshot);
    await scope.tx.insert(patientDocuments).values({
      id,
      tenantId: scope.tenantId,
      patientId: patient.id,
      branchId,
      documentTemplateId: tpl.id,
      documentVersion: tpl.version,
      contentSnapshotEncrypted: encryptField(JSON.stringify(snapshot), snapshotAad(scope.tenantId, id)),
      contentSha256,
      createdByUserId: ctx.userId,
    });
    await touchPatientBranch(scope, patient.id, branchId);
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_DOCUMENT_CREATED",
      entityType: "patient_document",
      entityId: id,
      branchId,
      metadata: { patientId: patient.id, documentType: tpl.type, documentVersion: tpl.version },
    });
    return { id, documentVersion: tpl.version, contentSha256, type: tpl.type };
  });
}

/** Geriye uyumluluk (Sprint 0). */
export const generatePatientDocument = createPatientDocument;

/** DRAFT → PRESENTED ve önizleme (snapshot'tan — şablondan DEĞİL). */
export async function presentPatientDocument(ctx: AuthContext, rawId: unknown): Promise<DocumentPreview> {
  requirePermission(ctx, "patient.document.present");
  return tenantQuery(ctx, async (scope) => {
    const doc = await loadAccessibleDocument(scope, ctx, rawId, { forUpdate: true });
    if (doc.status === "SIGNED") throw new AppError("DOCUMENT_ALREADY_SIGNED");
    if (doc.status === "VOIDED") throw new AppError("CONFLICT");
    const snapshot = readSnapshot(scope, doc);
    if (doc.status === "DRAFT") {
      await scope.tx
        .update(patientDocuments)
        .set({ status: "PRESENTED", presentedAt: new Date() })
        .where(tenantWhere(patientDocuments, scope, eq(patientDocuments.id, doc.id)));
      await writeAudit(scope, actorOf(ctx), {
        action: "PATIENT_DOCUMENT_PRESENTED",
        entityType: "patient_document",
        entityId: doc.id,
        branchId: doc.branchId,
        metadata: { documentType: snapshot.type, documentVersion: snapshot.version },
      });
    }
    const [p] = await scope.tx
      .select({
        firstName: patients.firstName,
        lastName: patients.lastName,
        patientNumber: patients.patientNumber,
      })
      .from(patients)
      .where(tenantWhere(patients, scope, eq(patients.id, doc.patientId)));
    return {
      documentId: doc.id,
      patientId: doc.patientId,
      patientName: `${p!.firstName} ${p!.lastName}`,
      patientNumber: p!.patientNumber,
      status: "PRESENTED",
      snapshot,
      contentSha256: doc.contentSha256!,
    };
  });
}

/** Geriye uyumluluk (Sprint 0). */
export async function markDocumentPresented(ctx: AuthContext, rawId: unknown): Promise<void> {
  await presentPatientDocument(ctx, rawId);
}

// ---------------------------------------------------------------- imzalama

/** Şablon seçim tanımlarına göre gelen seçimleri doğrular (aydınlatma ≠ rıza). */
export function validateChoices(
  defs: TemplateChoice[],
  given: Record<string, "READ_AND_INFORMED" | "GRANTED" | "DENIED">,
): {
  key: string;
  label: string;
  kind: TemplateChoice["kind"];
  value: "READ_AND_INFORMED" | "GRANTED" | "DENIED";
}[] {
  const out: {
    key: string;
    label: string;
    kind: TemplateChoice["kind"];
    value: "READ_AND_INFORMED" | "GRANTED" | "DENIED";
  }[] = [];
  for (const key of Object.keys(given)) {
    if (!defs.some((d) => d.key === key)) throw new AppError("VALIDATION", { fields: ["choices"] });
  }
  for (const def of defs) {
    const value = given[def.key];
    if (value === undefined) {
      if (def.required) throw new AppError("VALIDATION", { fields: ["choices"] });
      continue;
    }
    const allowed =
      def.kind === "ACKNOWLEDGEMENT" ? value === "READ_AND_INFORMED" : value !== "READ_AND_INFORMED";
    if (!allowed) throw new AppError("VALIDATION", { fields: ["choices"] });
    out.push({ key: def.key, label: def.label, kind: def.kind, value });
  }
  return out;
}

/**
 * İmzalama (tek transaction, satır kilitli):
 *  1. İmza PNG'si sunucuda decode + yeniden kodlanır (yalnızca statik raster; meta veri atılır).
 *  2. Belge SELECT … FOR UPDATE ile kilitlenir → eşzamanlı ikinci istek bekler, ardından SIGNED görür:
 *     DOCUMENT_ALREADY_SIGNED.
 *  3. Snapshot çözülür ve özeti doğrulanır; istemcinin önizlediği özetle karşılaştırılır (TOCTOU).
 *  4. Seçimler snapshot'taki şemaya göre doğrulanır.
 *  5. Final PDF üretilir → SHA-256 → imza + PDF özel depoya şifreli yazılır (üzerine yazılamaz).
 *  6. Seçimler eklenir, belge SIGNED olur (DB tetikleyicisi bundan sonra değişikliği engeller), audit yazılır.
 */
export async function signPatientDocument(
  ctx: AuthContext,
  rawId: unknown,
  input: unknown,
): Promise<{ documentSha256: string; contentSha256: string }> {
  requirePermission(ctx, "patient.document.sign");
  const data = parseInput(signDocumentSchema, input);
  const signerType = data.signerType ?? (data.guardianName ? "LEGAL_GUARDIAN" : "PATIENT");
  if (signerType !== "PATIENT" && !data.guardianRelationship && !data.guardianName) {
    throw new AppError("VALIDATION", { fields: ["guardianRelationship"] });
  }

  let signature: { png: Buffer };
  try {
    signature = await sanitizeSignaturePng(decodeSignatureDataUrl(data.signaturePng));
  } catch (e) {
    if (e instanceof InvalidSignatureError) throw new AppError("VALIDATION", { fields: ["signaturePng"] });
    throw e;
  }

  return tenantQuery(ctx, async (scope) => {
    const doc = await loadAccessibleDocument(scope, ctx, rawId, { forUpdate: true });
    if (doc.status === "SIGNED") throw new AppError("DOCUMENT_ALREADY_SIGNED");
    if (doc.status === "VOIDED") throw new AppError("CONFLICT");
    const snapshot = readSnapshot(scope, doc);
    if (data.expectedContentSha256 && data.expectedContentSha256 !== doc.contentSha256) {
      throw new AppError("CONFLICT", {
        message: "Önizlenen belge ile imzalanacak belge aynı değil. Belgeyi yeniden açın.",
      });
    }
    const choices = validateChoices(snapshot.choices, data.choices);

    const [patient] = await scope.tx
      .select()
      .from(patients)
      .where(tenantWhere(patients, scope, eq(patients.id, doc.patientId)));
    const [branch] = await scope.tx
      .select()
      .from(branches)
      .where(tenantWhere(branches, scope, eq(branches.id, doc.branchId)));
    const [tenant] = await scope.tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, scope.tenantId));
    const [profile] = await scope.tx
      .select({ phone: clinicProfiles.phone, website: clinicProfiles.website })
      .from(clinicProfiles)
      .where(tenantWhere(clinicProfiles, scope));
    if (!patient || !branch || !tenant) throw new AppError("NOT_FOUND");

    const branding = await clinicBrandingForScope(scope);
    const signedAt = new Date();
    const evidence: SignedDocumentEvidence = {
      documentId: doc.id,
      documentType: snapshot.type,
      templateName: snapshot.name,
      documentVersion: snapshot.version,
      content: snapshot.content,
      choices,
      clinicName: branding.displayName ?? tenant.name,
      clinicLegalName: branding.legalName,
      clinicPhone: profile?.phone ?? branch.phone,
      clinicWebsite: profile?.website ?? null,
      branchName: branch.name,
      branchAddress: branch.address,
      logoSha256: branding.logoPng ? sha256Hex(branding.logoPng) : null,
      patientName: `${patient.firstName} ${patient.lastName}`,
      patientNumber: patient.patientNumber,
      signedByName: data.signedByName,
      signerType,
      guardianName: signerType === "PATIENT" ? null : (data.guardianName ?? data.signedByName),
      guardianRelationship: signerType === "PATIENT" ? null : (data.guardianRelationship ?? null),
      signedAtIso: signedAt.toISOString(),
      timezone: branch.timezone,
      signaturePngSha256: sha256Hex(signature.png),
      contentSha256: doc.contentSha256,
    };
    const pdf = await renderSignedDocumentPdf(evidence, signature.png, { logoPng: branding.logoPng });
    const documentSha256 = sha256Hex(pdf);

    // Depolama yazımları DB güncellemesinden önce; DB yazımı başarısız olursa geride bağlanmamış (orphan)
    // şifreli nesne kalabilir — deleteIfAllowed ile imha politikası kapsamında temizlenir (KNOWN LIMITATIONS).
    const signatureKey = newStorageKey(scope.tenantId, "signatures");
    const pdfKey = newStorageKey(scope.tenantId, "documents");
    const storage = getPrivateStorage();
    await storage.put(signatureKey, signature.png);
    await storage.put(pdfKey, pdf);

    if (choices.length) {
      await scope.tx.insert(consentChoices).values(
        choices.map((c) => ({
          tenantId: scope.tenantId,
          patientDocumentId: doc.id,
          key: c.key,
          value: c.value,
          decidedAt: signedAt,
        })),
      );
    }
    await scope.tx
      .update(patientDocuments)
      .set({
        status: "SIGNED",
        presentedAt: doc.presentedAt ?? signedAt,
        signedAt,
        signedByName: data.signedByName,
        signerType,
        guardianName: evidence.guardianName ?? null,
        guardianRelationship: evidence.guardianRelationship ?? null,
        signatureStorageKey: signatureKey,
        pdfStorageKey: pdfKey,
        documentSha256,
      })
      .where(tenantWhere(patientDocuments, scope, eq(patientDocuments.id, doc.id)));
    await touchPatientBranch(scope, doc.patientId, doc.branchId);

    const base = { documentId: doc.id, documentType: snapshot.type, documentVersion: snapshot.version };
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_DOCUMENT_SIGNED",
      entityType: "patient_document",
      entityId: doc.id,
      branchId: doc.branchId,
      metadata: { ...base, patientId: doc.patientId, signerType, documentSha256 },
    });
    for (const c of choices.filter((x) => x.kind === "CONSENT")) {
      await writeAudit(scope, actorOf(ctx), {
        action: c.value === "GRANTED" ? "CONSENT_GRANTED" : "CONSENT_DENIED",
        entityType: "patient_document",
        entityId: doc.id,
        branchId: doc.branchId,
        metadata: { ...base, patientId: doc.patientId, consentKey: c.key },
      });
    }
    return { documentSha256, contentSha256: doc.contentSha256! };
  });
}

// ---------------------------------------------------------------- VOID

export async function voidPatientDocument(
  ctx: AuthContext,
  rawId: unknown,
  rawReason: unknown,
): Promise<void> {
  requirePermission(ctx, "patient.document.void");
  const reason = parseInput(z.string().trim().min(5).max(500), rawReason);
  await tenantQuery(ctx, async (scope) => {
    const doc = await loadAccessibleDocument(scope, ctx, rawId, { forUpdate: true });
    if (doc.status === "VOIDED") throw new AppError("CONFLICT");
    // Orijinal PDF, imza, hash ve snapshot DEĞİŞMEZ; yalnızca geçersiz kılma kaydı eklenir (DB tetikleyicisi zorlar).
    await scope.tx
      .update(patientDocuments)
      .set({ status: "VOIDED", voidedAt: new Date(), voidedByUserId: ctx.userId, voidReason: reason })
      .where(tenantWhere(patientDocuments, scope, eq(patientDocuments.id, doc.id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_DOCUMENT_VOIDED",
      entityType: "patient_document",
      entityId: doc.id,
      branchId: doc.branchId,
      metadata: { documentId: doc.id, documentVersion: doc.documentVersion, previousStatus: doc.status },
    });
  });
}

// ---------------------------------------------------------------- okuma / erişim

export type PatientDocumentListItem = {
  id: string;
  type: DocumentType;
  title: string;
  name: string;
  documentVersion: number;
  status: "DRAFT" | "PRESENTED" | "SIGNED" | "VOIDED";
  signedAt: Date | null;
  signedByName: string | null;
  signerType: string | null;
  branchId: string;
  branchName: string;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
};

export async function listPatientDocuments(
  ctx: AuthContext,
  rawPatientId: unknown,
): Promise<PatientDocumentListItem[]> {
  requirePermission(ctx, "patient.document.read");
  return tenantQuery(ctx, async (scope) => {
    const patient = await loadVisiblePatient(scope, ctx, rawPatientId);
    const rows = await scope.tx
      .select({
        id: patientDocuments.id,
        type: documentTemplates.type,
        name: documentTemplates.name,
        documentVersion: patientDocuments.documentVersion,
        status: patientDocuments.status,
        signedAt: patientDocuments.signedAt,
        signedByName: patientDocuments.signedByName,
        signerType: patientDocuments.signerType,
        branchId: patientDocuments.branchId,
        branchName: branches.name,
        createdAt: patientDocuments.createdAt,
        voidedAt: patientDocuments.voidedAt,
        voidReason: patientDocuments.voidReason,
      })
      .from(patientDocuments)
      .innerJoin(documentTemplates, eq(documentTemplates.id, patientDocuments.documentTemplateId))
      .innerJoin(
        branches,
        and(eq(branches.id, patientDocuments.branchId), eq(branches.tenantId, patientDocuments.tenantId)),
      )
      .where(tenantWhere(patientDocuments, scope, eq(patientDocuments.patientId, patient.id)))
      .orderBy(desc(patientDocuments.createdAt));
    return rows
      .filter((r) => canAccessBranch(ctx, r.branchId))
      .map((r) => ({ ...r, title: documentTitleOf(r.type) }));
  });
}

/** Belge kaydı (depolama anahtarları ASLA dönmez). */
export async function getPatientDocument(ctx: AuthContext, rawId: unknown) {
  requirePermission(ctx, "patient.document.read");
  return tenantQuery(ctx, async (scope) => {
    const doc = await loadAccessibleDocument(scope, ctx, rawId);
    const choices = await scope.tx
      .select({
        id: consentChoices.id,
        key: consentChoices.key,
        value: consentChoices.value,
        decidedAt: consentChoices.decidedAt,
      })
      .from(consentChoices)
      .where(tenantWhere(consentChoices, scope, eq(consentChoices.patientDocumentId, doc.id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_DOCUMENT_VIEWED",
      entityType: "patient_document",
      entityId: doc.id,
      branchId: doc.branchId,
      metadata: { documentId: doc.id, documentVersion: doc.documentVersion },
    });
    const { signatureStorageKey: s, pdfStorageKey: p, contentSnapshotEncrypted: _snap, ...safe } = doc;
    return { ...safe, hasSignature: Boolean(s), hasPdf: Boolean(p), choices };
  });
}

/** Belge önizlemesi (imza ekranı için): snapshot + özet. Belge durumunu değiştirmez. */
export async function getDocumentPreview(ctx: AuthContext, rawId: unknown): Promise<DocumentPreview> {
  if (!hasPermission(ctx, "patient.document.present")) requirePermission(ctx, "patient.document.read");
  return tenantQuery(ctx, async (scope) => {
    const doc = await loadAccessibleDocument(scope, ctx, rawId);
    const snapshot = readSnapshot(scope, doc);
    const [p] = await scope.tx
      .select({
        firstName: patients.firstName,
        lastName: patients.lastName,
        patientNumber: patients.patientNumber,
      })
      .from(patients)
      .where(tenantWhere(patients, scope, eq(patients.id, doc.patientId)));
    return {
      documentId: doc.id,
      patientId: doc.patientId,
      patientName: `${p!.firstName} ${p!.lastName}`,
      patientNumber: p!.patientNumber,
      status: doc.status,
      snapshot,
      contentSha256: doc.contentSha256!,
    };
  });
}

async function recordIntegrityFailure(
  ctx: AuthContext,
  doc: { id: string; branchId: string; documentVersion: number },
  part: string,
) {
  // Ayrı transaction: hata fırlatılsa bile audit kaydı kalıcı olur. PDF baytları audit'e YAZILMAZ.
  await tenantQuery(ctx, (scope) =>
    writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_DOCUMENT_INTEGRITY_FAILED",
      entityType: "patient_document",
      entityId: doc.id,
      branchId: doc.branchId,
      metadata: { documentId: doc.id, documentVersion: doc.documentVersion, part },
    }),
  );
}

/**
 * Bütünlük doğrulaması: depodaki PDF'in SHA-256'sı DB'deki document_sha256 ile, snapshot'ın kanonik özeti
 * content_sha256 ile karşılaştırılır. Uyuşmazlıkta DOCUMENT_INTEGRITY_FAILED + audit; belge sunulmaz.
 */
export async function verifyPatientDocumentIntegrity(
  ctx: AuthContext,
  rawId: unknown,
): Promise<{ documentSha256: string; contentSha256: string }> {
  requirePermission(ctx, "patient.document.read");
  const { doc, pdf, snapshotOk } = await tenantQuery(ctx, async (scope) => {
    const d = await loadAccessibleDocument(scope, ctx, rawId);
    if (d.status !== "SIGNED" && d.status !== "VOIDED") throw new AppError("NOT_FOUND");
    let ok = true;
    try {
      readSnapshot(scope, d);
    } catch {
      ok = false;
    }
    const data =
      d.pdfStorageKey && keyBelongsToTenant(d.pdfStorageKey, scope.tenantId)
        ? await getPrivateStorage()
            .get(d.pdfStorageKey)
            .catch(() => null)
        : null;
    return { doc: d, pdf: data, snapshotOk: ok };
  });
  if (!snapshotOk) {
    await recordIntegrityFailure(ctx, doc, "content");
    throw new AppError("DOCUMENT_INTEGRITY_FAILED");
  }
  if (!pdf || sha256Hex(pdf) !== doc.documentSha256) {
    await recordIntegrityFailure(ctx, doc, "pdf");
    throw new AppError("DOCUMENT_INTEGRITY_FAILED");
  }
  return { documentSha256: doc.documentSha256!, contentSha256: doc.contentSha256! };
}

/**
 * İmzalı PDF / imza görüntüsü — yalnızca yetkili kullanıcıya, sunucu üzerinden (public URL yok).
 * patientId verilirse belge o hastaya ait olmalı (aksi halde NOT_FOUND). PDF sunulmadan önce bütünlüğü doğrulanır.
 */
export async function readDocumentFile(
  ctx: AuthContext,
  rawId: unknown,
  kind: "pdf" | "signature",
  opts: { patientId?: unknown; download?: boolean } = {},
): Promise<{ data: Buffer; contentType: string; sha256Ok: boolean; documentId: string }> {
  requirePermission(ctx, "patient.document.read");
  const { doc, data, corrupt } = await tenantQuery(ctx, async (scope) => {
    const d = await loadAccessibleDocument(scope, ctx, rawId);
    if (opts.patientId !== undefined && d.patientId !== parseId(opts.patientId))
      throw new AppError("NOT_FOUND");
    const key = kind === "pdf" ? d.pdfStorageKey : d.signatureStorageKey;
    if (!key || !keyBelongsToTenant(key, scope.tenantId)) throw new AppError("NOT_FOUND");
    // Şifreli nesnenin kimlik doğrulaması (AES-GCM) başarısızsa = kurcalanmış → bütünlük ihlali, "yok" DEĞİL.
    let corrupt = false;
    const bytes = await getPrivateStorage()
      .get(key)
      .catch(() => {
        corrupt = true;
        return null;
      });
    return { doc: d, data: bytes, corrupt };
  });
  // İmzalı belgenin PDF'i eksik / bozuk ya da imza görüntüsü bozuk → kanıt zinciri kırık.
  if (corrupt || (kind === "pdf" && (!data || sha256Hex(data) !== doc.documentSha256))) {
    await recordIntegrityFailure(ctx, doc, kind);
    throw new AppError("DOCUMENT_INTEGRITY_FAILED");
  }
  if (!data) throw new AppError("NOT_FOUND");
  await tenantQuery(ctx, (scope) =>
    writeAudit(scope, actorOf(ctx), {
      action: opts.download ? "PATIENT_DOCUMENT_DOWNLOADED" : "PATIENT_DOCUMENT_VIEWED",
      entityType: "patient_document",
      entityId: doc.id,
      branchId: doc.branchId,
      metadata: { documentId: doc.id, documentVersion: doc.documentVersion, file: kind },
    }),
  );
  return {
    data,
    contentType: kind === "pdf" ? "application/pdf" : "image/png",
    sha256Ok: true,
    documentId: doc.id,
  };
}

// ---------------------------------------------------------------- açık rıza durumu / geri çekme

export type ConsentState = "GRANTED" | "DENIED" | "REVOKED" | "NOT_ASKED";

async function latestConsentDecision(scope: TenantScope, patientId: string, key: string) {
  const [row] = await scope.tx
    .select({
      choiceId: consentChoices.id,
      value: consentChoices.value,
      decidedAt: consentChoices.decidedAt,
      documentId: patientDocuments.id,
      signedAt: patientDocuments.signedAt,
      revokedAt: consentRevocations.revokedAt,
    })
    .from(consentChoices)
    .innerJoin(
      patientDocuments,
      and(
        eq(patientDocuments.id, consentChoices.patientDocumentId),
        eq(patientDocuments.tenantId, consentChoices.tenantId),
      ),
    )
    .innerJoin(documentTemplates, eq(documentTemplates.id, patientDocuments.documentTemplateId))
    .leftJoin(
      consentRevocations,
      and(
        eq(consentRevocations.consentChoiceId, consentChoices.id),
        eq(consentRevocations.tenantId, consentChoices.tenantId),
      ),
    )
    .where(
      tenantWhere(
        consentChoices,
        scope,
        eq(consentChoices.key, key),
        eq(patientDocuments.patientId, patientId),
        eq(patientDocuments.status, "SIGNED"),
        inArray(documentTemplates.type, CONSENT_TYPES),
      ),
    )
    .orderBy(desc(patientDocuments.signedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Güncel rıza durumu: en son imzalı (VOID edilmemiş) belgedeki karar; GRANTED sonrası geri çekme → REVOKED;
 * hiç sorulmadıysa NOT_ASKED. NOT_ASKED hiçbir zaman GRANTED gibi yorumlanmaz.
 */
export async function getCurrentConsentState(
  ctx: AuthContext,
  rawPatientId: unknown,
  key: string,
): Promise<ConsentState> {
  requirePermission(ctx, "patient.document.read");
  return tenantQuery(ctx, async (scope) => {
    const patient = await loadVisiblePatient(scope, ctx, rawPatientId);
    const d = await latestConsentDecision(scope, patient.id, key);
    if (!d) return "NOT_ASKED";
    if (d.value === "GRANTED") return d.revokedAt ? "REVOKED" : "GRANTED";
    if (d.value === "DENIED") return "DENIED";
    return "NOT_ASKED";
  });
}

/** Bilinen tüm rıza anahtarları için güncel durum (hasta detay ekranı). */
export async function getPatientConsentStates(ctx: AuthContext, rawPatientId: unknown) {
  requirePermission(ctx, "patient.document.read");
  return tenantQuery(ctx, async (scope) => {
    const patient = await loadVisiblePatient(scope, ctx, rawPatientId);
    const keys = await scope.tx
      .selectDistinct({ key: consentChoices.key, value: consentChoices.value })
      .from(consentChoices)
      .innerJoin(
        patientDocuments,
        and(
          eq(patientDocuments.id, consentChoices.patientDocumentId),
          eq(patientDocuments.tenantId, consentChoices.tenantId),
        ),
      )
      .where(tenantWhere(consentChoices, scope, eq(patientDocuments.patientId, patient.id)));
    const out: { key: string; state: ConsentState; decidedAt: Date | null }[] = [];
    for (const k of [
      ...new Set(keys.filter((x) => x.value !== "READ_AND_INFORMED").map((x) => x.key)),
    ].sort()) {
      const d = await latestConsentDecision(scope, patient.id, k);
      out.push({
        key: k,
        state: !d ? "NOT_ASKED" : d.value === "GRANTED" ? (d.revokedAt ? "REVOKED" : "GRANTED") : "DENIED",
        decidedAt: d?.revokedAt ?? d?.decidedAt ?? null,
      });
    }
    return out;
  });
}

export const revokeConsentSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{1,40}$/),
  channel: z.enum(["IN_PERSON", "PHONE", "EMAIL", "WRITTEN", "PORTAL", "OTHER"]),
  reason: z.preprocess(blank, z.string().trim().max(300).optional()),
});

/** Açık rızayı geri çeker. Orijinal imzalı belge ve ConsentChoice DEĞİŞMEZ; yeni ConsentRevocation eklenir. */
export async function revokeConsent(
  ctx: AuthContext,
  rawPatientId: unknown,
  input: unknown,
): Promise<{ id: string }> {
  requirePermission(ctx, "patient.document.create");
  const data = parseInput(revokeConsentSchema, input);
  return tenantQuery(ctx, async (scope) => {
    const patient = await loadVisiblePatient(scope, ctx, rawPatientId);
    const d = await latestConsentDecision(scope, patient.id, data.key);
    if (!d || d.value !== "GRANTED" || d.revokedAt) {
      throw new AppError("CONFLICT", { message: "Geri çekilecek geçerli bir açık rıza yok." });
    }
    const [row] = await scope.tx
      .insert(consentRevocations)
      .values({
        tenantId: scope.tenantId,
        patientId: patient.id,
        consentChoiceId: d.choiceId,
        revokedByUserId: ctx.userId,
        channel: data.channel,
        reason: data.reason ?? null,
      })
      .returning({ id: consentRevocations.id });
    await writeAudit(scope, actorOf(ctx), {
      action: "CONSENT_REVOKED",
      entityType: "patient",
      entityId: patient.id,
      branchId: patient.primaryBranchId,
      // Neden (reason) serbest metindir → audit'e yazılmaz.
      metadata: { documentId: d.documentId, consentKey: data.key, channel: data.channel },
    });
    return { id: row!.id };
  });
}
