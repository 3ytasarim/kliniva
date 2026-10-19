"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/guards";
import { formToObject, runAction, runData, type ActionState, type DataResult } from "@/server/action-result";
import {
  createPatient,
  findPossibleDuplicatePatients,
  updatePatient,
  updatePatientHealthProfile,
  type DuplicateCandidate,
} from "@/server/services/patients";
import { createPatientLookup, setPatientLookupActive } from "@/server/services/patient-lookups";
import {
  createPatientDocument,
  createTemplateVersion,
  presentPatientDocument,
  publishTemplate,
  revokeConsent,
  signPatientDocument,
  voidPatientDocument,
  type DocumentPreview,
} from "@/server/services/documents";

/**
 * Hasta CRM + KVKK akışı server action'ları. Her biri: requireUser() → servis (yetki + Zod + kiracı/şube kapsamı +
 * audit). İstemciye yalnızca hata KODU ve genel mesaj döner; ayrıntı / veri sızmaz.
 */
export type { DataResult };

// ---------------------------------------------------------------- hasta
export async function checkDuplicatesAction(input: {
  phone?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  birthDate?: string;
  excludeId?: string;
}): Promise<DataResult<DuplicateCandidate[]>> {
  return runData(async () => findPossibleDuplicatePatients(await requireUser(), input));
}

export async function createPatientAction(
  input: Record<string, string>,
): Promise<DataResult<{ id: string; patientNumber: string; duplicateCount: number }>> {
  return runData(async () => {
    const r = await createPatient(await requireUser(), input);
    revalidatePath("/patients");
    return { id: r.id, patientNumber: r.patientNumber, duplicateCount: r.duplicates.length };
  });
}

export async function updatePatientAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, ...rest } = formToObject(form);
    await updatePatient(await requireUser(), id, rest);
    revalidatePath(`/patients/${id}`);
    return "Hasta bilgileri güncellendi.";
  });
}

// ---------------------------------------------------------------- belgeler
export async function createDocumentAction(input: {
  patientId: string;
  type: string;
  branchId?: string;
}): Promise<DataResult<{ id: string; documentVersion: number }>> {
  return runData(async () => {
    const r = await createPatientDocument(await requireUser(), input);
    return { id: r.id, documentVersion: r.documentVersion };
  });
}

/** Belge oluştur + sun (önizleme snapshot'ı döner). Sihirbaz adım 2/3. */
export async function prepareDocumentAction(input: {
  patientId: string;
  type: string;
  branchId?: string;
}): Promise<DataResult<DocumentPreview>> {
  return runData(async () => {
    const ctx = await requireUser();
    const doc = await createPatientDocument(ctx, input);
    return presentPatientDocument(ctx, doc.id);
  });
}

export async function signDocumentAction(input: {
  documentId: string;
  signaturePng: string;
  choices: Record<string, "READ_AND_INFORMED" | "GRANTED" | "DENIED">;
  signedByName: string;
  signerType?: string;
  guardianRelationship?: string;
  expectedContentSha256: string;
}): Promise<DataResult<{ documentSha256: string }>> {
  return runData(async () => {
    const { documentId, ...rest } = input;
    const r = await signPatientDocument(await requireUser(), documentId, rest);
    return { documentSha256: r.documentSha256 };
  });
}

export async function voidDocumentAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, reason, patientId } = formToObject(form);
    await voidPatientDocument(await requireUser(), id, reason);
    revalidatePath(`/patients/${patientId}`);
    return "Belge geçersiz kılındı (orijinal PDF korunur).";
  });
}

export async function revokeConsentAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { patientId, ...rest } = formToObject(form);
    await revokeConsent(await requireUser(), patientId, rest);
    revalidatePath(`/patients/${patientId}`);
    return "Açık rıza geri çekildi (orijinal imzalı belge değişmez).";
  });
}

// ---------------------------------------------------------------- şablonlar
/**
 * Seçimler satır satır: ANAHTAR | Etiket | ACKNOWLEDGEMENT veya CONSENT | zorunlu (evet/hayır)
 */
function parseChoicesText(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [key = "", label = "", kind = "CONSENT", required = "evet"] = line
        .split("|")
        .map((x) => x.trim());
      return {
        key,
        label,
        kind: kind.toUpperCase() === "ACKNOWLEDGEMENT" ? "ACKNOWLEDGEMENT" : "CONSENT",
        required: !/^(hayır|hayir|no|false|0)$/i.test(required),
      };
    });
}

export async function createTemplateVersionAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    const { version } = await createTemplateVersion(await requireUser(), {
      type: data.type,
      name: data.name,
      content: data.content,
      choices: parseChoicesText(data.choices ?? ""),
    });
    revalidatePath("/settings/documents");
    return `Taslak v${version} oluşturuldu. Yayımlayana kadar hastalara sunulmaz.`;
  });
}

export async function publishTemplateAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await publishTemplate(await requireUser(), form.get("id"));
    revalidatePath("/settings/documents");
    return "Şablon yayımlandı; önceki versiyon pasifleşti (imzalı belgeler etkilenmez).";
  });
}

// ---------------------------------------------------------------- Sprint 8.1: sağlık profili + hasta tanımları
export async function updateHealthProfileAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, ...rest } = formToObject(form);
    await updatePatientHealthProfile(await requireUser(), id, rest);
    revalidatePath(`/patients/${id}`);
    return "Sağlık bilgileri kaydedildi.";
  });
}

export async function createPatientLookupAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await createPatientLookup(await requireUser(), formToObject(form));
    revalidatePath("/settings/patient-definitions");
    return "Tanım eklendi.";
  });
}

export async function togglePatientLookupAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, active } = formToObject(form);
    await setPatientLookupActive(await requireUser(), id, active === "true");
    revalidatePath("/settings/patient-definitions");
    return active === "true" ? "Tanım etkinleştirildi." : "Tanım pasifleştirildi.";
  });
}
