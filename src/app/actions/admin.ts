"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/guards";
import { formToObject, runAction, type ActionState } from "@/server/action-result";
import { createUser } from "@/server/services/users";
import { confirmMfaEnrollment, revokeOtherSessions, startMfaEnrollment } from "@/server/services/mfa";

/** Tüm server action'lar: requireUser() (oturum) → servis (yetki + Zod + audit). */

export async function createUserAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    await createUser(await requireUser(), {
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
      password: data.password,
      roles: [{ roleKey: data.roleKey, branchId: data.branchId || null }],
    });
    revalidatePath("/admin/users");
    return "Kullanıcı oluşturuldu.";
  });
}

export async function confirmMfaAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await confirmMfaEnrollment(await requireUser(), form.get("code"));
    revalidatePath("/settings/security");
    return "İki adımlı doğrulama etkinleştirildi.";
  });
}

export async function revokeOtherSessionsAction(_p: ActionState): Promise<ActionState> {
  return runAction(async () => {
    await revokeOtherSessions(await requireUser());
    return "Diğer tüm oturumlar kapatıldı.";
  });
}

export type MfaEnrollmentState = { ok: boolean; message?: string; secret?: string; uri?: string } | null;

/** Kurulum sırrını yalnızca kullanıcının kendisine, bir kez gösterir (DB'de şifreli). */
export async function startMfaAction(_p: MfaEnrollmentState): Promise<MfaEnrollmentState> {
  const ctx = await requireUser(); // oturum yoksa /login yönlendirmesi burada (try dışında) gerçekleşir
  try {
    const { secret, uri } = await startMfaEnrollment(ctx);
    return { ok: true, secret, uri };
  } catch {
    return { ok: false, message: "İki adımlı doğrulama zaten etkin veya başlatılamadı." };
  }
}
