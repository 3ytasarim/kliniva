import type { Metadata } from "next";
import { ActionForm, Field } from "@/components/action-form";
import { mfaAction } from "@/app/actions/auth";

export const metadata: Metadata = { title: "İki adımlı doğrulama" };

export default function MfaPage() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="mb-2 text-center text-lg font-semibold">İki adımlı doğrulama</h1>
        <p className="mb-6 text-center text-sm text-slate-600 dark:text-slate-400">
          Doğrulama uygulamanızdaki 6 haneli kodu girin.
        </p>
        <div className="card">
          <ActionForm action={mfaAction} submitLabel="Doğrula">
            <Field
              label="Doğrulama kodu"
              name="code"
              required
              autoComplete="one-time-code"
              inputMode="numeric"
            />
          </ActionForm>
        </div>
      </div>
    </main>
  );
}
