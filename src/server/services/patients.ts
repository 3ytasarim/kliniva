import "server-only";
import type { DuplicateCandidate } from "@/types/patients";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  branches,
  clinicProfiles,
  patientBranches,
  patients,
  tenants,
  users,
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
import { decryptField, encryptField } from "@/server/security/crypto";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { emailSchema, nameSchema, uuidSchema } from "@/server/validation";
import { parseInput } from "@/server/services/parse";
import { maskPhoneNumber, normalizeEmailAddress, normalizePhone } from "@/lib/phone";

/**
 * Hasta CRM servisi.
 *
 *  - Kiracı izolasyonu: tenantQuery (RLS FORCE) + açık tenantWhere.
 *  - Şube kapsamı: şube kapsamlı kullanıcı yalnızca yetkili olduğu şubeyle İLİŞKİLİ (patient_branches) hastaları
 *    görür; yalnızca primaryBranchId'ye bakılmaz. Kiracı geneli kullanıcı (sahip / yönetici) hepsini görür.
 *  - Erişilemeyen / başka kiracıya ait hasta → NOT_FOUND (IDOR'da varlık sızdırılmaz).
 *  - Hasta numarası: kiracı başına atomik sayaç (tenants.patient_seq UPDATE … RETURNING → satır kilidi) +
 *    klinik öneki → eşzamanlı kayıtlarda tekrar YOK; (tenant_id, patient_number) benzersiz.
 *  - Tıbbi not ve TC kimlik yalnızca şifreli (AAD = kiracı + hasta). TC düz metin olarak asla yazılmaz/dönmez.
 *  - Liste: minimum veri (maskeli telefon). KVKK durumu belgelerden TÜRETİLİR (hastada onay bayrağı tutulmaz).
 */
const notesAad = (tenantId: string, patientId: string) => `patient.notes:${tenantId}:${patientId}`;
const nationalIdAad = (tenantId: string, patientId: string) => `patient.national_id:${tenantId}:${patientId}`;

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optText = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());
const phoneField = z
  .string()
  .trim()
  .min(7)
  .max(25)
  .refine((v) => normalizePhone(v) !== null, "invalid phone");

/** TC kimlik no algoritma kontrolü (11 hane, ilk hane ≠ 0, iki kontrol hanesi). */
export function isValidTurkishNationalId(v: string): boolean {
  if (!/^[1-9]\d{10}$/.test(v)) return false;
  const d = v.split("").map(Number);
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  if ((((odd * 7 - even) % 10) + 10) % 10 !== d[9]) return false;
  return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}

const patientFields = {
  primaryBranchId: z.preprocess(blank, uuidSchema.optional()),
  firstName: nameSchema,
  lastName: nameSchema,
  phone: phoneField,
  secondaryPhone: z.preprocess(blank, phoneField.optional()),
  email: z.preprocess(blank, emailSchema.optional()),
  birthDate: z.preprocess(blank, z.iso.date().optional()),
  gender: z.preprocess(blank, z.enum(["FEMALE", "MALE", "OTHER", "UNDISCLOSED"]).optional()),
  nationality: z.preprocess(blank, z.string().trim().toUpperCase().length(2).optional()),
  preferredLanguage: z.preprocess(blank, z.enum(["TR", "EN", "DE", "AR", "RU", "FR"]).optional()),
  address: optText(500),
  city: optText(80),
  district: optText(80),
  emergencyContactName: optText(120),
  emergencyContactPhone: z.preprocess(blank, phoneField.optional()),
  nationalId: z.preprocess(
    blank,
    z.string().trim().refine(isValidTurkishNationalId, "invalid national id").optional(),
  ),
  notes: z.preprocess(blank, z.string().max(10_000).optional()),
};

/** Geriye uyumluluk: eski istemciler "branchId" gönderebilir → primaryBranchId. */
const withBranchAlias = (v: unknown) => {
  if (v && typeof v === "object" && "branchId" in v && !("primaryBranchId" in v)) {
    const { branchId, ...rest } = v as Record<string, unknown>;
    return { ...rest, primaryBranchId: branchId };
  }
  return v;
};

export const createPatientSchema = z.preprocess(withBranchAlias, z.object(patientFields));
export const updatePatientSchema = z.preprocess(
  withBranchAlias,
  z.object(patientFields).partial().extend({ active: z.boolean().optional() }),
);

export type PrivacyStatus = "MISSING" | "PARTIAL" | "COMPLETE";

export type PatientListItem = {
  id: string;
  patientNumber: string;
  firstName: string;
  lastName: string;
  phoneMasked: string;
  primaryBranchId: string | null;
  primaryBranchName: string | null;
  privacyStatus: PrivacyStatus;
  hasPendingDocuments: boolean;
  active: boolean;
  updatedAt: Date;
};

export type PatientDetail = {
  id: string;
  patientNumber: string;
  primaryBranchId: string | null;
  primaryBranchName: string | null;
  branches: { id: string; name: string; firstSeenAt: Date; lastSeenAt: Date }[];
  firstName: string;
  lastName: string;
  phone: string;
  secondaryPhone: string | null;
  email: string | null;
  birthDate: string | null;
  gender: string | null;
  nationality: string | null;
  preferredLanguage: string;
  address: string | null;
  city: string | null;
  district: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  /** TC kimlik yalnızca maskeli (son 2 hane) döner; tam değer API'den hiç dönmez. */
  nationalIdMasked: string | null;
  active: boolean;
  privacyStatus: PrivacyStatus;
  createdAt: Date;
  updatedAt: Date;
  /** Yalnızca patient.health.read yetkisinde dolu; aksi halde alan hiç gönderilmez. */
  health?: { notes: string | null };
};

/** Geriye uyumluluk (Sprint 0 testleri / ekranları). */
export const maskPhone = maskPhoneNumber;

/**
 * Şube kapsamı SQL koşulu (kiracı geneli kullanıcıda undefined).
 * Not: Drizzle sql`` içindeki sütunları nitelendirmeden yazdığı için dış tablo AÇIKÇA (kliniva.patients) yazılır.
 */
export function patientScopeFilter(ctx: AuthContext): SQL | undefined {
  if (ctx.branchScope.all) return undefined;
  const ids = [...ctx.branchScope.branchIds];
  if (!ids.length) return sql`false`;
  return sql`exists (select 1 from kliniva.patient_branches pb
    where pb.tenant_id = kliniva.patients.tenant_id and pb.patient_id = kliniva.patients.id
      and pb.branch_id in (${sql.join(
        ids.map((i) => sql`${i}::uuid`),
        sql`, `,
      )}))`;
}

/** Belgelerden türetilen KVKK durumu için SQL bayrakları (yalnızca imzalı ve VOID edilmemiş belgeler sayılır). */
const privacyFlags = {
  disclosureSigned: sql<boolean>`exists (select 1 from kliniva.patient_documents d join kliniva.document_templates t on t.id = d.document_template_id
    where d.tenant_id = kliniva.patients.tenant_id and d.patient_id = kliniva.patients.id and d.status = 'SIGNED' and t.type = 'KVKK_DISCLOSURE')`,
  consentDecided: sql<boolean>`exists (select 1 from kliniva.patient_documents d join kliniva.document_templates t on t.id = d.document_template_id
    where d.tenant_id = kliniva.patients.tenant_id and d.patient_id = kliniva.patients.id and d.status = 'SIGNED' and t.type = 'EXPLICIT_CONSENT')`,
  pending: sql<boolean>`exists (select 1 from kliniva.patient_documents d
    where d.tenant_id = kliniva.patients.tenant_id and d.patient_id = kliniva.patients.id and d.status in ('DRAFT', 'PRESENTED'))`,
};

/**
 * KVKK durumu:
 *  COMPLETE → aydınlatma imzalı VE (açık rıza şablonu varsa) rıza belgesi imzalı — rızanın GRANTED veya DENIED
 *             olması fark etmez: reddetmek de geçerli bir karardır.
 *  PARTIAL  → bir kısmı imzalı ya da bekleyen (DRAFT/PRESENTED) belge var.
 *  MISSING  → hiçbir belge yok.
 */
export function computePrivacyStatus(f: {
  disclosureSigned: boolean;
  consentDecided: boolean;
  pending: boolean;
  consentRequired: boolean;
}): PrivacyStatus {
  if (f.disclosureSigned && (!f.consentRequired || f.consentDecided)) return "COMPLETE";
  if (f.disclosureSigned || f.consentDecided || f.pending) return "PARTIAL";
  return "MISSING";
}

async function consentRequired(scope: TenantScope): Promise<boolean> {
  const r = await scope.tx.execute<{ required: boolean }>(sql`
    select exists (select 1 from kliniva.document_templates t
      where (t.tenant_id = ${scope.tenantId}::uuid or t.tenant_id is null)
        and t.type = 'EXPLICIT_CONSENT' and t.active and t.published_at is not null) as required`);
  return Boolean(r.rows[0]?.required);
}

/** Kapsam içinde hastayı yükler; yoksa / erişilemiyorsa NOT_FOUND. */
export async function loadVisiblePatient(scope: TenantScope, ctx: AuthContext, rawId: unknown) {
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  const [row] = await scope.tx
    .select()
    .from(patients)
    .where(tenantWhere(patients, scope, eq(patients.id, id.data), patientScopeFilter(ctx)));
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

/** Hasta ↔ şube ilişkisini kaydeder / son görülme zamanını günceller. */
export async function touchPatientBranch(scope: TenantScope, patientId: string, branchId: string) {
  await scope.tx
    .insert(patientBranches)
    .values({ tenantId: scope.tenantId, patientId, branchId })
    .onConflictDoUpdate({
      target: [patientBranches.tenantId, patientBranches.patientId, patientBranches.branchId],
      set: { lastSeenAt: new Date() },
    });
}

async function nextPatientNumber(scope: TenantScope): Promise<string> {
  // UPDATE … RETURNING satırı kilitler: eşzamanlı istekler sırayla benzersiz değer alır.
  const [seq] = await scope.tx
    .update(tenants)
    .set({ patientSeq: sql`${tenants.patientSeq} + 1` })
    .where(eq(tenants.id, scope.tenantId))
    .returning({ value: tenants.patientSeq });
  const [profile] = await scope.tx
    .select({ prefix: clinicProfiles.patientNumberPrefix })
    .from(clinicProfiles)
    .where(tenantWhere(clinicProfiles, scope));
  return `${profile?.prefix ?? "KLI"}-${String(seq!.value).padStart(6, "0")}`;
}

// ---------------------------------------------------------------- olası kopya kayıt

export type { DuplicateCandidate };

type DuplicateInput = {
  phone?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  birthDate?: string;
  excludeId?: string;
};

/**
 * Deterministik, birebir eşleşme (bulanık / AI eşleştirme YOK): normalize telefon, normalize e-posta,
 * ad + soyad + doğum tarihi. Sonuç yalnızca bu kiracı + kullanıcının şube kapsamı. Otomatik birleştirme YAPILMAZ.
 */
export async function findPossibleDuplicatePatients(
  ctx: AuthContext,
  input: DuplicateInput,
): Promise<DuplicateCandidate[]> {
  requirePermission(ctx, "patient.read");
  return tenantQuery(ctx, (scope) => findDuplicatesInScope(scope, ctx, input));
}

async function findDuplicatesInScope(
  scope: TenantScope,
  ctx: AuthContext,
  input: DuplicateInput,
): Promise<DuplicateCandidate[]> {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmailAddress(input.email);
  const nameBirth =
    input.firstName && input.lastName && input.birthDate && /^\d{4}-\d{2}-\d{2}$/.test(input.birthDate)
      ? {
          first: input.firstName.trim().toLocaleLowerCase("tr-TR"),
          last: input.lastName.trim().toLocaleLowerCase("tr-TR"),
          birth: input.birthDate,
        }
      : null;
  const conds: SQL[] = [];
  if (phone) conds.push(eq(patients.phoneNormalized, phone));
  if (email) conds.push(eq(patients.emailNormalized, email));
  if (nameBirth) {
    conds.push(
      and(
        sql`lower(${patients.firstName}) = ${nameBirth.first}`,
        sql`lower(${patients.lastName}) = ${nameBirth.last}`,
        eq(patients.birthDate, nameBirth.birth),
      )!,
    );
  }
  if (!conds.length) return [];
  const excludeId = input.excludeId && uuidSchema.safeParse(input.excludeId).success ? input.excludeId : null;
  const rows = await scope.tx
    .select({
      id: patients.id,
      patientNumber: patients.patientNumber,
      firstName: patients.firstName,
      lastName: patients.lastName,
      phoneNormalized: patients.phoneNormalized,
      emailNormalized: patients.emailNormalized,
      birthDate: patients.birthDate,
    })
    .from(patients)
    .where(
      tenantWhere(
        patients,
        scope,
        or(...conds),
        patientScopeFilter(ctx),
        excludeId ? sql`${patients.id} <> ${excludeId}::uuid` : undefined,
      ),
    )
    .limit(10);
  return rows.map((r) => ({
    id: r.id,
    patientNumber: r.patientNumber,
    firstName: r.firstName,
    lastName: r.lastName,
    matchedOn: [
      ...(phone && r.phoneNormalized === phone ? (["PHONE"] as const) : []),
      ...(email && r.emailNormalized === email ? (["EMAIL"] as const) : []),
      ...(nameBirth &&
      r.firstName.toLocaleLowerCase("tr-TR") === nameBirth.first &&
      r.lastName.toLocaleLowerCase("tr-TR") === nameBirth.last &&
      r.birthDate === nameBirth.birth
        ? (["NAME_BIRTHDATE"] as const)
        : []),
    ],
  }));
}

// ---------------------------------------------------------------- liste / arama

export const SEARCH_LIMITS = {
  defaultLimit: 25,
  maxLimit: 100,
  minQueryLength: 2,
  maxQueryLength: 100,
} as const;

const escapeLike = (v: string) => v.replace(/[%_\\]/g, "\\$&");

export type PatientListOptions = {
  q?: string;
  branchId?: string;
  status?: "active" | "inactive" | "all";
  page?: number;
  limit?: number;
};

export async function listPatients(
  ctx: AuthContext,
  opts: PatientListOptions = {},
): Promise<{ items: PatientListItem[]; total: number; page: number; limit: number }> {
  requirePermission(ctx, "patient.read");
  const limit = Math.min(
    Math.max(Math.trunc(opts.limit ?? SEARCH_LIMITS.defaultLimit), 1),
    SEARCH_LIMITS.maxLimit,
  );
  const page = Math.max(Math.trunc(opts.page ?? 1), 1);
  const q = opts.q?.trim().slice(0, SEARCH_LIMITS.maxQueryLength) ?? "";
  if (q && q.length < SEARCH_LIMITS.minQueryLength) {
    throw new AppError("VALIDATION", { fields: ["q"], message: "Arama için en az 2 karakter girin." });
  }
  const branchId = opts.branchId && uuidSchema.safeParse(opts.branchId).success ? opts.branchId : undefined;
  if (branchId && !canAccessBranch(ctx, branchId)) return { items: [], total: 0, page, limit };

  // Her sözcük ad / soyad / hasta no / normalize telefon / e-posta önekiyle eşleşmeli (büyük-küçük harf duyarsız).
  const tokenConds: SQL[] = q
    ? q
        .split(/\s+/)
        .slice(0, 4)
        .map((tok) => {
          const like = `%${escapeLike(tok)}%`;
          const digits = tok.replace(/\D/g, "");
          const phone = normalizePhone(tok);
          return or(
            ilike(patients.firstName, like),
            ilike(patients.lastName, like),
            ilike(patients.patientNumber, like),
            phone ? eq(patients.phoneNormalized, phone) : undefined,
            digits.length >= 4 ? sql`${patients.phoneNormalized} like ${`%${digits}%`}` : undefined,
            tok.length >= 3
              ? sql`${patients.emailNormalized} like ${`${escapeLike(tok.toLowerCase())}%`}`
              : undefined,
          )!;
        })
    : [];

  const where = (scope: TenantScope) =>
    tenantWhere(
      patients,
      scope,
      patientScopeFilter(ctx),
      branchId
        ? sql`exists (select 1 from kliniva.patient_branches pb2 where pb2.tenant_id = kliniva.patients.tenant_id
            and pb2.patient_id = kliniva.patients.id and pb2.branch_id = ${branchId}::uuid)`
        : undefined,
      opts.status === "inactive"
        ? eq(patients.active, false)
        : opts.status === "all"
          ? undefined
          : eq(patients.active, true),
      ...tokenConds,
    );

  return tenantQuery(ctx, async (scope) => {
    const required = await consentRequired(scope);
    const [counted] = await scope.tx
      .select({ total: sql<number>`count(*)::int` })
      .from(patients)
      .where(where(scope));
    const rows = await scope.tx
      .select({
        id: patients.id,
        patientNumber: patients.patientNumber,
        firstName: patients.firstName,
        lastName: patients.lastName,
        phone: patients.phone,
        primaryBranchId: patients.primaryBranchId,
        primaryBranchName: branches.name,
        active: patients.active,
        updatedAt: patients.updatedAt,
        ...privacyFlags,
      })
      .from(patients)
      .leftJoin(
        branches,
        and(eq(branches.id, patients.primaryBranchId), eq(branches.tenantId, patients.tenantId)),
      )
      .where(where(scope))
      .orderBy(desc(patients.updatedAt), asc(patients.patientNumber))
      .limit(limit)
      .offset((page - 1) * limit);
    return {
      total: counted?.total ?? 0,
      page,
      limit,
      items: rows.map(({ phone, disclosureSigned, consentDecided, pending, ...r }) => ({
        ...r,
        phoneMasked: maskPhoneNumber(phone),
        hasPendingDocuments: pending,
        privacyStatus: computePrivacyStatus({
          disclosureSigned,
          consentDecided,
          pending,
          consentRequired: required,
        }),
      })),
    };
  });
}

// ---------------------------------------------------------------- detay

export async function getPatient(ctx: AuthContext, rawId: unknown): Promise<PatientDetail> {
  requirePermission(ctx, "patient.read");
  const canHealth = hasPermission(ctx, "patient.health.read");
  return tenantQuery(ctx, async (scope) => {
    const row = await loadVisiblePatient(scope, ctx, rawId);
    const [flags] = await scope.tx
      .select(privacyFlags)
      .from(patients)
      .where(tenantWhere(patients, scope, eq(patients.id, row.id)));
    const required = await consentRequired(scope);
    const linked = await scope.tx
      .select({
        id: branches.id,
        name: branches.name,
        firstSeenAt: patientBranches.firstSeenAt,
        lastSeenAt: patientBranches.lastSeenAt,
      })
      .from(patientBranches)
      .innerJoin(
        branches,
        and(eq(branches.id, patientBranches.branchId), eq(branches.tenantId, patientBranches.tenantId)),
      )
      .where(tenantWhere(patientBranches, scope, eq(patientBranches.patientId, row.id)))
      .orderBy(asc(branches.name));
    const nationalId = row.nationalIdEncrypted
      ? decryptField(row.nationalIdEncrypted, nationalIdAad(scope.tenantId, row.id))
      : null;
    const detail: PatientDetail = {
      id: row.id,
      patientNumber: row.patientNumber,
      primaryBranchId: row.primaryBranchId,
      primaryBranchName: linked.find((b) => b.id === row.primaryBranchId)?.name ?? null,
      // Şube kapsamlı kullanıcı yalnızca kendi şubelerindeki geçmişi görür.
      branches: linked.filter((b) => canAccessBranch(ctx, b.id)),
      firstName: row.firstName,
      lastName: row.lastName,
      phone: row.phone,
      secondaryPhone: row.secondaryPhone,
      email: row.email,
      birthDate: row.birthDate,
      gender: row.gender,
      nationality: row.nationality,
      preferredLanguage: row.preferredLanguage,
      address: row.address,
      city: row.city,
      district: row.district,
      emergencyContactName: row.emergencyContactName,
      emergencyContactPhone: row.emergencyContactPhone,
      nationalIdMasked: nationalId ? `*********${nationalId.slice(-2)}` : null,
      active: row.active,
      privacyStatus: computePrivacyStatus({ ...flags!, consentRequired: required }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (canHealth) {
      detail.health = {
        notes: row.notesEncrypted ? decryptField(row.notesEncrypted, notesAad(scope.tenantId, row.id)) : null,
      };
    }
    await writeAudit(scope, actorOf(ctx), {
      action: canHealth ? "PATIENT_HEALTH_VIEWED" : "PATIENT_VIEWED",
      entityType: "patient",
      entityId: row.id,
      branchId: row.primaryBranchId,
    });
    return detail;
  });
}

// ---------------------------------------------------------------- oluştur / güncelle

export async function createPatient(
  ctx: AuthContext,
  input: unknown,
): Promise<{ id: string; patientNumber: string; duplicates: DuplicateCandidate[] }> {
  requirePermission(ctx, "patient.create");
  const data = parseInput(createPatientSchema, input);
  if (data.notes) requirePermission(ctx, "patient.health.write");
  // Şube kapsamlı kullanıcı yalnızca kendi şubesine, şubesiz hasta oluşturamaz.
  requireBranchAccess(ctx, data.primaryBranchId ?? null);

  return tenantQuery(ctx, async (scope) => {
    if (data.primaryBranchId) {
      const [b] = await scope.tx
        .select({ id: branches.id })
        .from(branches)
        .where(tenantWhere(branches, scope, eq(branches.id, data.primaryBranchId)));
      if (!b) throw new AppError("NOT_FOUND");
    }
    const duplicates = await findDuplicatesInScope(scope, ctx, data);
    const patientNumber = await nextPatientNumber(scope);
    const id = randomUUID();
    await scope.tx.insert(patients).values({
      id,
      tenantId: scope.tenantId,
      primaryBranchId: data.primaryBranchId ?? null,
      patientNumber,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
      phoneNormalized: normalizePhone(data.phone),
      secondaryPhone: data.secondaryPhone ?? null,
      email: data.email ?? null,
      emailNormalized: normalizeEmailAddress(data.email),
      birthDate: data.birthDate ?? null,
      gender: data.gender ?? null,
      nationality: data.nationality ?? null,
      preferredLanguage: data.preferredLanguage ?? "TR",
      address: data.address ?? null,
      city: data.city ?? null,
      district: data.district ?? null,
      emergencyContactName: data.emergencyContactName ?? null,
      emergencyContactPhone: data.emergencyContactPhone ?? null,
      nationalIdEncrypted: data.nationalId
        ? encryptField(data.nationalId, nationalIdAad(scope.tenantId, id))
        : null,
      notesEncrypted: data.notes ? encryptField(data.notes, notesAad(scope.tenantId, id)) : null,
      createdByUserId: ctx.userId,
    });
    if (data.primaryBranchId) await touchPatientBranch(scope, id, data.primaryBranchId);
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_CREATED",
      entityType: "patient",
      entityId: id,
      branchId: data.primaryBranchId ?? null,
      metadata: { hasHealthNotes: Boolean(data.notes), hasNationalId: Boolean(data.nationalId) },
    });
    if (duplicates.length) {
      await writeAudit(scope, actorOf(ctx), {
        action: "PATIENT_DUPLICATE_WARNING",
        entityType: "patient",
        entityId: id,
        branchId: data.primaryBranchId ?? null,
        metadata: {
          matchCount: duplicates.length,
          matchedOn: [...new Set(duplicates.flatMap((d) => d.matchedOn))].join(","),
        },
      });
    }
    return { id, patientNumber, duplicates };
  });
}

export async function updatePatient(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "patient.update");
  const data = parseInput(updatePatientSchema, input);
  if (data.notes !== undefined) requirePermission(ctx, "patient.health.write");
  if (data.active === false) requirePermission(ctx, "patient.delete");

  await tenantQuery(ctx, async (scope) => {
    const row = await loadVisiblePatient(scope, ctx, rawId);
    if (data.primaryBranchId !== undefined) requireBranchAccess(ctx, data.primaryBranchId);

    const changed = Object.keys(data).filter((k) => (data as Record<string, unknown>)[k] !== undefined);
    const { notes, nationalId, ...rest } = data;
    await scope.tx
      .update(patients)
      .set({
        ...rest,
        ...(rest.phone !== undefined ? { phoneNormalized: normalizePhone(rest.phone) } : {}),
        ...(rest.email !== undefined ? { emailNormalized: normalizeEmailAddress(rest.email) } : {}),
        ...(notes !== undefined
          ? { notesEncrypted: notes ? encryptField(notes, notesAad(scope.tenantId, row.id)) : null }
          : {}),
        ...(nationalId !== undefined
          ? {
              nationalIdEncrypted: nationalId
                ? encryptField(nationalId, nationalIdAad(scope.tenantId, row.id))
                : null,
            }
          : {}),
      })
      .where(tenantWhere(patients, scope, eq(patients.id, row.id)));
    if (data.primaryBranchId) await touchPatientBranch(scope, row.id, data.primaryBranchId);
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_UPDATED",
      entityType: "patient",
      entityId: row.id,
      branchId: row.primaryBranchId,
      // Yalnızca değişen ALAN ADLARI (değerler değil); sağlık / kimlik verisi ayrı bayrakla.
      metadata: {
        fields: changed.filter((f) => f !== "notes" && f !== "nationalId").join(","),
        healthNotesChanged: notes !== undefined,
        nationalIdChanged: nationalId !== undefined,
      },
    });
  });
}

/** Testler ve iç kullanım için: hasta kaydının kimliğe göre varlığı (aynı kiracı + şube kapsamı). */
export async function patientExists(ctx: AuthContext, rawId: unknown): Promise<boolean> {
  requirePermission(ctx, "patient.read");
  return tenantQuery(ctx, async (scope) => {
    try {
      await loadVisiblePatient(scope, ctx, rawId);
      return true;
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------- aktivite (audit)

export type PatientActivityItem = {
  id: string;
  action: string;
  createdAt: Date;
  actorName: string | null;
  source: string;
};

/**
 * Hastayla ilgili audit olayları (hasta kaydı + belgeleri). Yalnızca audit.read yetkisiyle; audit kayıtları zaten
 * içerik / PII taşımaz — burada yalnızca eylem kodu, zaman ve işlemi yapan personelin adı döner.
 */
export async function getPatientActivity(
  ctx: AuthContext,
  rawId: unknown,
  limit = 50,
): Promise<PatientActivityItem[]> {
  requirePermission(ctx, "audit.read");
  return tenantQuery(ctx, async (scope) => {
    const patient = await loadVisiblePatient(scope, ctx, rawId);
    const rows = await scope.tx
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        createdAt: auditLogs.createdAt,
        source: auditLogs.source,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(auditLogs)
      .leftJoin(users, and(eq(users.id, auditLogs.userId), eq(users.tenantId, auditLogs.tenantId)))
      .where(
        tenantWhere(
          auditLogs,
          scope,
          or(
            eq(auditLogs.entityId, patient.id),
            sql`${auditLogs.metadataSafe} ->> 'patientId' = ${patient.id}`,
          ),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      createdAt: r.createdAt,
      source: r.source,
      actorName: r.firstName ? `${r.firstName} ${r.lastName}` : null,
    }));
  });
}
