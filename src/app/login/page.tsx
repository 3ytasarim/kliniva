import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import { ActionForm, Field } from "@/components/action-form";
import { loginAction } from "@/app/actions/auth";

export const metadata: Metadata = { title: "Giriş" };

export default function LoginPage() {
  return (
    <main
      id="main"
      className="relative grid min-h-dvh place-items-center overflow-hidden bg-gradient-to-b from-brand-50/70 via-canvas to-canvas px-4 py-10 dark:from-brand-500/5 dark:via-canvas-dark dark:to-canvas-dark"
    >
      <div className="w-full max-w-sm">
        <div className="mb-8 grid justify-items-center text-center">
          {/* Logo: koyu temada koyu yazı okunur kalsın diye açık zemin üzerinde. */}
          <picture className="rounded-2xl dark:bg-white dark:px-5 dark:py-3 dark:shadow-raised">
            <source srcSet="/brand/kliniva-logo.webp" type="image/webp" />
            <img
              src="/brand/kliniva-logo.png"
              alt="Kliniva AI"
              width={200}
              height={171}
              className="h-auto w-[200px]"
            />
          </picture>
          <h1 className="mt-5 text-lg font-semibold tracking-tight">Klinik personeli girişi</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Randevu, muayene ve hasta yönetimi
          </p>
        </div>
        <div className="card p-6 shadow-raised">
          <ActionForm action={loginAction} submitLabel="Giriş yap">
            <Field
              label="Klinik kodu"
              name="tenantSlug"
              required
              autoComplete="organization"
              placeholder="örn. demo-klinik"
            />
            <Field
              label="E-posta veya kullanıcı adı"
              name="email"
              required
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
            />
            <Field label="Parola" name="password" type="password" required autoComplete="current-password" />
          </ActionForm>
        </div>
        <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-slate-500">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          Kişisel verileriniz 6698 sayılı KVKK kapsamında korunur.
        </p>
      </div>
    </main>
  );
}
