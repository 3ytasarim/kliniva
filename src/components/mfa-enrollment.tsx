"use client";

import { useActionState } from "react";
import { confirmMfaAction, startMfaAction } from "@/app/actions/admin";
import { ActionForm, Field } from "@/components/action-form";

/** MFA kurulumu: sır yalnızca kurulum anında kullanıcıya gösterilir; sunucuda şifreli saklanır. */
export function MfaEnrollment() {
  const [state, start, pending] = useActionState(startMfaAction, null);

  if (!state?.ok) {
    return (
      <form action={start} className="mt-4 grid gap-3">
        {state?.message ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {state.message}
          </p>
        ) : null}
        <div>
          <button type="submit" className="btn" disabled={pending}>
            {pending ? "Hazırlanıyor…" : "Kurulumu başlat"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="mt-4 grid gap-4">
      <div>
        <p className="text-sm">
          Doğrulama uygulamanıza (Google/Microsoft Authenticator vb.) aşağıdaki anahtarı elle ekleyin:
        </p>
        <code className="mt-2 block break-all rounded-lg bg-slate-100 p-3 font-mono text-sm dark:bg-slate-800">
          {state.secret}
        </code>
        <details className="mt-2 text-xs text-slate-500">
          <summary className="cursor-pointer">otpauth bağlantısı</summary>
          <code className="mt-1 block break-all">{state.uri}</code>
        </details>
      </div>
      <ActionForm action={confirmMfaAction} submitLabel="Doğrula ve etkinleştir">
        <Field
          label="Uygulamadaki 6 haneli kod"
          name="code"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
        />
      </ActionForm>
    </div>
  );
}
