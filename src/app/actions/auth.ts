"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { login, logout, verifyMfaLogin } from "@/server/auth/login";
import { sessionCookieName, sessionCookieOptions } from "@/server/auth/session";
import { requestMetaFrom } from "@/server/security/request-meta";
import type { ActionState } from "@/server/action-result";

export async function loginAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const jar = await cookies();
  const meta = requestMetaFrom(await headers());
  const result = await login(
    {
      tenantSlug: form.get("tenantSlug"),
      email: form.get("email"),
      password: form.get("password"),
    },
    meta,
    { previousToken: jar.get(sessionCookieName())?.value ?? null },
  );
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.code === "RATE_LIMITED"
          ? "Çok fazla başarısız deneme. Lütfen 15 dakika sonra tekrar deneyin."
          : "Klinik kodu, e-posta veya parola hatalı.",
    };
  }
  jar.set(sessionCookieName(), result.token, sessionCookieOptions(result.expiresAt));
  redirect(result.mfaRequired ? "/login/mfa" : "/dashboard");
}

export async function mfaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const jar = await cookies();
  const meta = requestMetaFrom(await headers());
  const result = await verifyMfaLogin(jar.get(sessionCookieName())?.value, form.get("code"), meta);
  if (!result.ok) {
    if (result.code === "SESSION_INVALID" || result.code === "RATE_LIMITED") {
      jar.delete(sessionCookieName());
      redirect("/login");
    }
    return { ok: false, message: "Doğrulama kodu geçersiz." };
  }
  jar.set(sessionCookieName(), result.token, sessionCookieOptions(result.expiresAt));
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  await logout(jar.get(sessionCookieName())?.value, requestMetaFrom(await headers()));
  jar.delete(sessionCookieName());
  redirect("/login");
}
