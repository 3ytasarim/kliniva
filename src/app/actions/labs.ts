"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/guards";
import { formToObject, runAction, type ActionState } from "@/server/action-result";
import { addLabResult, createLabPanel, updateLabPanel, voidLabResult } from "@/server/services/labs";

/** Tahlil server action'ları — yetki / kapsam / doğrulama / audit servis katmanında. */
export async function createLabPanelAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await createLabPanel(await requireUser(), formToObject(form));
    revalidatePath("/settings/lab-panels");
    return "Tahlil tipi eklendi.";
  });
}

export async function updateLabPanelAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, ...rest } = formToObject(form);
    await updateLabPanel(await requireUser(), id, { ...rest, active: rest.active ?? "false" });
    revalidatePath("/settings/lab-panels");
    return "Tahlil tipi güncellendi.";
  });
}

export async function addLabResultAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    await addLabResult(await requireUser(), data);
    revalidatePath(`/patients/${data.patientId}`);
    return "Tahlil sonucu kaydedildi.";
  });
}

export async function voidLabResultAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, patientId, reason } = formToObject(form);
    await voidLabResult(await requireUser(), id, { reason });
    revalidatePath(`/patients/${patientId}`);
    return "Sonuç geçersiz kılındı.";
  });
}
