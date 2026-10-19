"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/guards";
import { formToObject, runAction, type ActionState } from "@/server/action-result";
import { addCharge, recordPayment, voidCashTransaction, voidCharge } from "@/server/services/billing";
import { createCashCategory, createCashEntry, setCashCategoryActive } from "@/server/services/cash";

/**
 * Finans server action'ları — ince sarmalayıcı; yetki, şube kapsamı, doğrulama ve audit servis katmanında.
 * Formlardaki patientId / appointmentId istemciden gelir ama servis kapsam dışını NOT_FOUND ile reddeder.
 */
function revalidateFinance(form: Record<string, unknown>) {
  if (typeof form.patientId === "string") revalidatePath(`/patients/${form.patientId}`);
  if (typeof form.appointmentId === "string" && form.appointmentId) {
    revalidatePath(`/appointments/${form.appointmentId}`);
  }
  revalidatePath("/finance/cash");
  revalidatePath("/finance/balances");
  revalidatePath("/dashboard");
}

export async function addChargeAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    await addCharge(await requireUser(), data);
    revalidateFinance(data);
    return "Hizmet bedeli eklendi.";
  });
}

export async function recordPaymentAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    await recordPayment(await requireUser(), data);
    revalidateFinance(data);
    return "Tahsilat kaydedildi.";
  });
}

export async function voidChargeAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    await voidCharge(await requireUser(), data.id, data);
    revalidateFinance(data);
    return "Hizmet bedeli iptal edildi.";
  });
}

export async function voidCashAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    await voidCashTransaction(await requireUser(), data.id, data);
    revalidateFinance(data);
    return "Kayıt iptal edildi.";
  });
}

export async function createCashEntryAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    await createCashEntry(await requireUser(), data);
    revalidateFinance(data);
    return data.kind === "EXPENSE" ? "Gider kaydedildi." : "Gelir kaydedildi.";
  });
}

export async function createCashCategoryAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await createCashCategory(await requireUser(), formToObject(form));
    revalidatePath("/finance/cash");
    return "Kategori eklendi.";
  });
}

export async function toggleCashCategoryAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, active } = formToObject(form);
    await setCashCategoryActive(await requireUser(), id, active === "true");
    revalidatePath("/finance/cash");
    return active === "true" ? "Kategori etkinleştirildi." : "Kategori pasifleştirildi.";
  });
}
