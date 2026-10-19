"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { formToObject, runAction, type ActionState } from "@/server/action-result";
import { requestMetaFrom } from "@/server/security/request-meta";
import {
  platformCookieName,
  platformCookieOptions,
  platformLogin,
  platformLogout,
  platformVerifyMfa,
} from "@/server/platform/auth";
import { platformTokenFromCookies, requirePlatform } from "@/server/platform/guards";
import { createClinic, resetOwnerPassword, setClinicStatus } from "@/server/platform/clinics";

/** Platform (yazılım sahibi) server action'ları. Yetki: ACTIVE platform oturumu + DB fonksiyonunda tekrar doğrulama. */
export async function platformLoginAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const meta = requestMetaFrom(await headers());
  const r = await platformLogin(formToObject(form), meta);
  if (!r.ok) {
    return {
      ok: false,
      message:
        r.code === "RATE_LIMITED"
          ? "Çok fazla deneme. 15 dakika sonra tekrar deneyin."
          : "E-posta veya parola hatalı.",
    };
  }
  (await cookies()).set(platformCookieName(), r.token, platformCookieOptions(r.expiresAt));
  redirect("/platform/mfa");
}

export async function platformMfaAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const meta = requestMetaFrom(await headers());
  const r = await platformVerifyMfa(await platformTokenFromCookies(), form.get("code"), meta);
  if (!r.ok) {
    if (r.code === "SESSION_INVALID" || r.code === "RATE_LIMITED") {
      (await cookies()).delete(platformCookieName());
      redirect("/platform/login");
    }
    return { ok: false, message: "Kod geçersiz. Uygulamadaki güncel 6 haneli kodu girin." };
  }
  (await cookies()).set(platformCookieName(), r.token, platformCookieOptions(r.expiresAt));
  redirect("/platform");
}

export async function platformLogoutAction(): Promise<void> {
  const jar = await cookies();
  await platformLogout(jar.get(platformCookieName())?.value, requestMetaFrom(await headers()));
  jar.delete(platformCookieName());
  redirect("/platform/login");
}

export async function createClinicAction(_p: ActionState, form: FormData): Promise<ActionState> {
  let created: { tenantId: string } | null = null;
  const result = await runAction(async () => {
    created = await createClinic(await requirePlatform(), formToObject(form));
    return "Klinik oluşturuldu.";
  });
  if (result?.ok && created)
    redirect(`/platform/clinics/${(created as { tenantId: string }).tenantId}?created=1`);
  return result;
}

export async function setClinicStatusAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, status } = formToObject(form);
    await setClinicStatus(await requirePlatform(), id, status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE");
    revalidatePath("/platform");
    revalidatePath(`/platform/clinics/${id}`);
    return status === "SUSPENDED"
      ? "Klinik askıya alındı; tüm oturumlar kapatıldı."
      : "Klinik yeniden etkin.";
  });
}

export async function resetOwnerPasswordAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { tenantId, userId, password } = formToObject(form);
    await resetOwnerPassword(await requirePlatform(), tenantId, userId, password);
    revalidatePath(`/platform/clinics/${tenantId}`);
    return "Geçici parola kaydedildi. Yönetici ilk girişte değiştirmek zorunda.";
  });
}
