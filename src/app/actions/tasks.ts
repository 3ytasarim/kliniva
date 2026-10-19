"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/guards";
import { formToObject, runAction, type ActionState } from "@/server/action-result";
import { closeTask, createTask, editTask } from "@/server/services/tasks";

/** Hasta görevi server action'ları — ince sarmalayıcı; yetki / kapsam / doğrulama / audit servis katmanında. */
function revalidateTasks(patientId?: string) {
  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  if (patientId) revalidatePath(`/patients/${patientId}`);
}

export async function createTaskAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    await createTask(await requireUser(), data);
    revalidateTasks(data.patientId);
    return "Görev oluşturuldu.";
  });
}

export async function editTaskAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, patientId, ...rest } = formToObject(form);
    await editTask(await requireUser(), id, rest);
    revalidateTasks(patientId);
    return "Görev güncellendi.";
  });
}

export async function closeTaskAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, patientId, status, result } = formToObject(form);
    await closeTask(await requireUser(), id, { status, result });
    revalidateTasks(patientId);
    return status === "DONE"
      ? "Görev tamamlandı."
      : status === "UNREACHABLE"
        ? "Ulaşılamadı olarak kapatıldı."
        : "Görev iptal edildi.";
  });
}
