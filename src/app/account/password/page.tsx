import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { requireUserForPasswordChange } from "@/server/auth/guards";
import { changePasswordAction } from "@/app/actions/account";
import { logoutAction } from "@/app/actions/auth";
import { ActionForm, Field } from "@/components/action-form";

export const metadata: Metadata = { title: "Parola değiştir" };

/**
 * Parola değiştirme. Geçici parolayla (yönetici / platform tarafından verilen) giriş yapan kullanıcı, parolasını
 * değiştirene kadar uygulamanın başka bir sayfasına geçemez.
 */
export default async function ChangePasswordPage() {
  const ctx = await requireUserForPasswordChange();
  const forced = ctx.user.mustChangePassword;
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 grid justify-items-center text-center">
          <span className="grid size-12 place-items-center rounded-2xl bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
            <KeyRound className="size-6" aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            {forced ? "Yeni parolanızı belirleyin" : "Parola değiştir"}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {forced
              ? "Hesabınız geçici bir parolayla açıldı. Devam etmek için kendi parolanızı belirleyin."
              : "Güvenliğiniz için güçlü ve başka yerde kullanmadığınız bir parola seçin."}
          </p>
        </div>
        <div className="card p-6">
          <ActionForm action={changePasswordAction} submitLabel="Parolayı kaydet">
            <Field
              label={forced ? "Geçici parola" : "Mevcut parola"}
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
              idPrefix="cp"
            />
            <Field
              label="Yeni parola"
              name="newPassword"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              hint="En az 12 karakter; harf ve rakam içermeli."
              idPrefix="cp"
            />
            <Field
              label="Yeni parola (tekrar)"
              name="confirmPassword"
              type="password"
              required
              autoComplete="new-password"
              idPrefix="cp"
            />
          </ActionForm>
        </div>
        <div className="mt-5 flex items-center justify-center gap-4 text-sm">
          {forced ? null : (
            <Link
              href="/dashboard"
              className="font-medium text-brand-700 hover:underline dark:text-brand-300"
            >
              Panele dön
            </Link>
          )}
          <form action={logoutAction}>
            <button
              type="submit"
              className="font-medium text-slate-500 hover:text-slate-900 dark:hover:text-white"
            >
              Çıkış yap
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
