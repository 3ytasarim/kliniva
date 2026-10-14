import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  branches,
  consentChoices,
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
  requireBranchAccess,
  requirePermission,
  type AuthContext,
} from "@/server/auth/authz";
import { sha256Hex } from "@/server/security/crypto";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { getPrivateStorage } from "@/server/storage/private-storage";
import {
  decodeSignatureDataUrl,
  InvalidSignatureError,
  sanitizeSignaturePng,
} from "@/server/documents/signature";
import { renderSignedDocumentPdf, type SignedDocumentEvidence } from "@/server/documents/pdf";
import { clinicBrandingForScope } from "@/server/services/clinic";
import { uuidSchema } from "@/server/validation";
import { parseInput } from "@/server/services/parse";

/**
 * KVKK belge mimarisi.
 *
 *   DocumentTemplate (versiyonlu, yayımlanınca değişmez)
 *        └─ PatientDocument (hastaya sunulan örnek; imzalanınca değişmez)
 *               └─ ConsentChoice (her seçim ayrı satır)
 *
 * Aydınlatma (KVKK_DISCLOSURE) ile açık rıza (EXPLICIT_CONSENT) AYRI belge tipleridir:
 *  - Aydınlatma metninde yalnızca ACKNOWLEDGEMENT seçimi olur ve değeri READ_AND_INFORMED'dır (rıza DEĞİLDİR).
 *  - Açık rıza seçimleri CONSENT türündedir: GRANTED / DENIED — özgür iradeyle, ayrı ayrı verilir.
 * Bu kurallar hem burada hem veritabanı tetikleyicisinde uygulanır.
 */
const templateChoiceSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(300),
  kind: z.enum(["ACKNOWLEDGEMENT", "CONSENT"]),
  required: z.boolean(),
});

export const templateVersionSchema = z
  .object({
    type: z.enum(["KVKK_DISCLOSURE", "EXPLICIT_CONSENT", "TREATMENT_CONSENT", "OTHER"]),
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

export const signDocumentSchema = z.object({
  signedByName: z.string().trim().min(2).max(150),
  guardianName: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().min(2).max(150).optional()),
  signaturePng: z.string().min(20).max(450_000),
  choices: z.record(z.string(), z.enum(["READ_AND_INFORMED", "GRANTED", "DENIED"])),
});

// ---------------------------------------------------------------- şablonlar

export async function listTemplates(ctx: AuthContext) {
  requirePermission(ctx, "document.read");
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
      })
      .from(documentTemplates)
      // RLS platform (NULL) + kendi kiracı satırlarını gösterir; açık filtre de aynı kuralı uygular.
      .where(or(isNull(documentTemplates.tenantId), eq(documentTemplates.tenantId, scope.tenantId)))
      .orderBy(documentTemplates.type, desc(documentTemplates.version)),
  );
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

/** Yayımlar; aynı tipteki eski versiyonlar pasifleşir (ama silinmez — imzalı belgeler onlara bağlıdır). */
export async function publishTemplate(ctx: AuthContext, rawId: unknown): Promise<void> {
  requirePermission(ctx, "document.template.manage");
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  await tenantQuery(ctx, async (scope) => {
    const [tpl] = await scope.tx
      .select()
      .from(documentTemplates)
      .where(tenantWhere(documentTemplates, scope, eq(documentTemplates.id, id.data)));
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

// ---------------------------------------------------------------- hasta belgeleri

async function loadAccessiblePatient(scope: TenantScope, ctx: AuthContext, patientId: string) {
  const [p] = await scope.tx
    .select()
    .from(patients)
    .where(tenantWhere(patients, scope, eq(patients.id, patientId)));
  if (!p || !(ctx.branchScope.all || (p.branchId && canAccessBranch(ctx, p.branchId)))) {
    throw new AppError("NOT_FOUND");
  }
  return p;
}

async function loadAccessibleDocument(scope: TenantScope, ctx: AuthContext, rawId: unknown) {
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  const [doc] = await scope.tx
    .select()
    .from(patientDocuments)
    .where(tenantWhere(patientDocuments, scope, eq(patientDocuments.id, id.data)));
  if (!doc || !canAccessBranch(ctx, doc.branchId)) throw new AppError("NOT_FOUND");
  return doc;
}

/** Hasta için güncel (yayımlanmış, aktif) şablon versiyonundan belge örneği üretir. */
export async function generatePatientDocument(
  ctx: AuthContext,
  input: unknown,
): Promise<{ id: string; documentVersion: number }> {
  requirePermission(ctx, "document.sign");
  const data = parseInput(
    z.object({ patientId: uuidSchema, templateId: uuidSchema, branchId: uuidSchema.optional() }),
    input,
  );
  return tenantQuery(ctx, async (scope) => {
    const patient = await loadAccessiblePatient(scope, ctx, data.patientId);
    const branchId = data.branchId ?? patient.branchId;
    if (!branchId) throw new AppError("VALIDATION", { fields: ["branchId"] });
    requireBranchAccess(ctx, branchId);

    const [tpl] = await scope.tx
      .select()
      .from(documentTemplates)
      .where(
        and(
          eq(documentTemplates.id, data.templateId),
          or(isNull(documentTemplates.tenantId), eq(documentTemplates.tenantId, scope.tenantId)),
        ),
      );
    if (!tpl || !tpl.publishedAt || !tpl.active) throw new AppError("NOT_FOUND");

    const id = randomUUID();
    await scope.tx.insert(patientDocuments).values({
      id,
      tenantId: scope.tenantId,
      patientId: patient.id,
      branchId,
      documentTemplateId: tpl.id,
      documentVersion: tpl.version,
      createdByUserId: ctx.userId,
    });
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_DOCUMENT_GENERATED",
      entityType: "patient_document",
      entityId: id,
      branchId,
      metadata: { patientId: patient.id, type: tpl.type, version: tpl.version },
    });
    return { id, documentVersion: tpl.version };
  });
}

export async function markDocumentPresented(ctx: AuthContext, rawId: unknown): Promise<void> {
  requirePermission(ctx, "document.sign");
  await tenantQuery(ctx, async (scope) => {
    const doc = await loadAccessibleDocument(scope, ctx, rawId);
    if (doc.status !== "GENERATED") throw new AppError("CONFLICT");
    await scope.tx
      .update(patientDocuments)
      .set({ status: "PRESENTED", presentedAt: new Date() })
      .where(tenantWhere(patientDocuments, scope, eq(patientDocuments.id, doc.id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_DOCUMENT_PRESENTED",
      entityType: "patient_document",
      entityId: doc.id,
      branchId: doc.branchId,
    });
  });
}

/** Şablon seçim tanımlarına göre gelen seçimleri doğrular (aydınlatma ≠ rıza). */
export function validateChoices(
  defs: TemplateChoice[],
  given: Record<string, "READ_AND_INFORMED" | "GRANTED" | "DENIED">,
): { key: string; label: string; value: "READ_AND_INFORMED" | "GRANTED" | "DENIED" }[] {
  const out: { key: string; label: string; value: "READ_AND_INFORMED" | "GRANTED" | "DENIED" }[] = [];
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
    out.push({ key: def.key, label: def.label, value });
  }
  return out;
}

/**
 * İmzalama akışı:
 *  1. Yetki + belge erişimi + durum (GENERATED/PRESENTED) kontrolü
 *  2. Seçimlerin şablona göre doğrulanması
 *  3. İmza PNG'sinin temizlenmesi (yalnızca statik görüntü) → özel depoya şifreli yazılır
 *  4. Final PDF üretimi → SHA-256 → özel depoya şifreli yazılır
 *  5. Tek transaction: seçimler eklenir, belge SIGNED olur (sonrası DB tetikleyicisiyle değişmez), audit yazılır
 */
export async function signPatientDocument(
  ctx: AuthContext,
  rawId: unknown,
  input: unknown,
): Promise<{ documentSha256: string }> {
  requirePermission(ctx, "document.sign");
  const data = parseInput(signDocumentSchema, input);

  let signature: { png: Buffer };
  try {
    signature = sanitizeSignaturePng(decodeSignatureDataUrl(data.signaturePng));
  } catch (e) {
    if (e instanceof InvalidSignatureError) throw new AppError("VALIDATION", { fields: ["signaturePng"] });
    throw e;
  }

  return tenantQuery(ctx, async (scope) => {
    const doc = await loadAccessibleDocument(scope, ctx, rawId);
    if (doc.status !== "GENERATED" && doc.status !== "PRESENTED") throw new AppError("CONFLICT");

    const [tpl] = await scope.tx
      .select()
      .from(documentTemplates)
      .where(eq(documentTemplates.id, doc.documentTemplateId));
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
    if (!tpl || !patient || !branch || !tenant) throw new AppError("NOT_FOUND");

    const choices = validateChoices(tpl.choices, data.choices);
    const signedAt = new Date();
    const storage = getPrivateStorage();
    const signatureKey = `${scope.tenantId}/signatures/${randomUUID()}.png`;
    const pdfKey = `${scope.tenantId}/pdfs/${randomUUID()}.pdf`;

    // Klinik profili (Sprint 1): görünen ad / ticari unvan / logo; profil yoksa kiracı adı.
    const branding = await clinicBrandingForScope(scope);
    const evidence: SignedDocumentEvidence = {
      documentId: doc.id,
      clinicName: branding.displayName ?? tenant.name,
      clinicLegalName: branding.legalName,
      branchName: branch.name,
      branchAddress: branch.address,
      logoSha256: branding.logoPng ? sha256Hex(branding.logoPng) : null,
      patientName: `${patient.firstName} ${patient.lastName}`,
      patientNumber: patient.patientNumber,
      documentType: tpl.type,
      templateName: tpl.name,
      documentVersion: tpl.version,
      content: tpl.content,
      choices,
      signedByName: data.signedByName,
      guardianName: data.guardianName ?? null,
      signedAtIso: signedAt.toISOString(),
      timezone: branch.timezone,
      signaturePngSha256: sha256Hex(signature.png),
    };
    const pdf = await renderSignedDocumentPdf(evidence, signature.png, { logoPng: branding.logoPng });
    const documentSha256 = sha256Hex(pdf);

    // Depolama yazımları transaction'dan önce tamamlanır; DB yazımı başarısız olursa geride bağlanmamış (orphan)
    // şifreli nesne kalabilir — periyodik temizlik Sprint 1+ (docs/KNOWN LIMITATIONS).
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
        signedAt,
        signedByName: data.signedByName,
        guardianName: data.guardianName ?? null,
        signatureStorageKey: signatureKey,
        pdfStorageKey: pdfKey,
        documentSha256,
      })
      .where(tenantWhere(patientDocuments, scope, eq(patientDocuments.id, doc.id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_DOCUMENT_SIGNED",
      entityType: "patient_document",
      entityId: doc.id,
      branchId: doc.branchId,
      metadata: {
        patientId: patient.id,
        type: tpl.type,
        version: tpl.version,
        hasGuardian: Boolean(data.guardianName),
        documentSha256,
      },
    });
    return { documentSha256 };
  });
}

export async function getPatientDocument(ctx: AuthContext, rawId: unknown) {
  requirePermission(ctx, "document.read");
  return tenantQuery(ctx, async (scope) => {
    const doc = await loadAccessibleDocument(scope, ctx, rawId);
    const choices = await scope.tx
      .select({ key: consentChoices.key, value: consentChoices.value, decidedAt: consentChoices.decidedAt })
      .from(consentChoices)
      .where(tenantWhere(consentChoices, scope, eq(consentChoices.patientDocumentId, doc.id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_DOCUMENT_VIEWED",
      entityType: "patient_document",
      entityId: doc.id,
      branchId: doc.branchId,
    });
    const { signatureStorageKey: _s, pdfStorageKey: _p, ...safe } = doc;
    return { ...safe, hasSignature: Boolean(_s), hasPdf: Boolean(_p), choices };
  });
}

/** İmzalı PDF / imza görüntüsü: yalnızca yetkili kullanıcıya, sunucu üzerinden (public URL yok). */
export async function readDocumentFile(
  ctx: AuthContext,
  rawId: unknown,
  kind: "pdf" | "signature",
): Promise<{ data: Buffer; contentType: string; sha256Ok: boolean }> {
  requirePermission(ctx, "document.read");
  return tenantQuery(ctx, async (scope) => {
    const doc = await loadAccessibleDocument(scope, ctx, rawId);
    const key = kind === "pdf" ? doc.pdfStorageKey : doc.signatureStorageKey;
    if (!key) throw new AppError("NOT_FOUND");
    const data = await getPrivateStorage().get(key);
    if (!data) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_DOCUMENT_VIEWED",
      entityType: "patient_document",
      entityId: doc.id,
      branchId: doc.branchId,
      metadata: { file: kind },
    });
    return {
      data,
      contentType: kind === "pdf" ? "application/pdf" : "image/png",
      sha256Ok: kind === "pdf" ? sha256Hex(data) === doc.documentSha256 : true,
    };
  });
}
