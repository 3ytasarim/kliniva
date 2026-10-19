"use server";

import { redirect } from "next/navigation";
import { requireUserForPasswordChange } from "@/server/auth/guards";
import { formToObject, runAction, type ActionState } from "@/server/action-result";
import { changeOwnPassword } from "@/server/services/account";

/** Kendi parolasını değiştirme. Başarılıysa (ilk giriş dahil) panele yönlendirir. */
export async function changePasswordAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction(async () => {
    await changeOwnPassword(await requireUserForPasswordChange(), formToObject(form));
    return "Parolanız değiştirildi.";
  });
  if (result?.ok) redirect("/dashboard");
  return result;
}
