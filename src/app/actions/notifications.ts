"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/guards";
import { formToObject, runAction, type ActionState } from "@/server/action-result";
import {
  archiveNotification,
  markAllNotificationsRead,
  markNotificationRead,
  setNotificationPreference,
} from "@/server/services/notifications";
import { retryFailedOutboxEvent } from "@/server/notifications/outbox";

/** Bildirim server action'ları — alıcı her zaman oturumdan (servis katmanı); form yalnızca bildirim kimliği taşır. */
export async function markNotificationReadAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await markNotificationRead(await requireUser(), formToObject(form).id);
    revalidatePath("/notifications");
    return "Okundu olarak işaretlendi.";
  });
}

export async function markAllNotificationsReadAction(_p: ActionState, _form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const r = await markAllNotificationsRead(await requireUser());
    revalidatePath("/notifications");
    return `${r.updated} bildirim okundu olarak işaretlendi.`;
  });
}

export async function archiveNotificationAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await archiveNotification(await requireUser(), formToObject(form).id);
    revalidatePath("/notifications");
    return "Arşivlendi.";
  });
}

export async function setNotificationPreferenceAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { type, inAppEnabled } = formToObject(form);
    await setNotificationPreference(await requireUser(), { type, inAppEnabled });
    revalidatePath("/notifications");
    return "Tercih kaydedildi.";
  });
}

export async function retryOutboxEventAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await retryFailedOutboxEvent(await requireUser(), formToObject(form).id);
    revalidatePath("/settings/system-events");
    return "Olay yeniden kuyruğa alındı.";
  });
}
