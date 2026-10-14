import type { Metadata } from "next";
import { ActionForm, Field } from "@/components/action-form";
import { loginAction } from "@/app/actions/auth";

export const metadata: Metadata = { title: "Giriş" };

export default function LoginPage() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-2xl font-bold tracking-tight text-brand-700 dark:text-brand-100">Kliniva AI</p>
          <h1 className="mt-1 text-sm text-slate-600 dark:text-slate-400">Klinik personeli girişi</h1>
        </div>
        <div className="card">
          <ActionForm action={loginAction} submitLabel="Giriş yap">
            <Field
              label="Klinik kodu"
              name="tenantSlug"
              required
              autoComplete="organization"
              placeholder="ornek-klinik"
            />
            <Field label="E-posta" name="email" type="email" required autoComplete="username" />
            <Field label="Parola" name="password" type="password" required autoComplete="current-password" />
          </ActionForm>
        </div>
        <p className="mt-6 text-center text-xs text-slate-500">
          Kişisel verileriniz 6698 sayılı KVKK kapsamında korunur.
        </p>
      </div>
    </main>
  );
}
