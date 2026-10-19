import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { platformMfaAction } from "@/app/actions/platform";
import { ActionForm, Field } from "@/components/action-form";
import { platformMfaSetupInfo, resolvePlatformSession } from "@/server/platform/auth";
import { platformTokenFromCookies } from "@/server/platform/guards";

export const metadata: Metadata = { title: "İki adımlı doğrulama" };

/**
 * İki adımlı doğrulama. İlk girişte kurulum: anahtar doğrulama uygulamasına eklenir ve ilk kodla etkinleşir.
 * Sonraki girişlerde yalnızca kod istenir.
 */
export default async function PlatformMfaPage() {
  const session = await resolvePlatformSession(await platformTokenFromCookies());
  if (!session) redirect("/platform/login");
  if (session.state === "ACTIVE") redirect("/platform");
  const setup = session.state === "MFA_SETUP" ? await platformMfaSetupInfo(session) : null;
  return (
    <div className="card grid gap-4 p-6">
      {setup ? (
        <div>
          <p className="text-sm font-semibold">İlk giriş: iki adımlı doğrulamayı kurun</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Doğrulama uygulamanıza (Google / Microsoft Authenticator) bu anahtarı elle ekleyin:
          </p>
          <code
            data-testid="platform-mfa-secret"
            className="mt-2 block break-all rounded-lg bg-slate-100 p-3 font-mono text-sm dark:bg-white/5"
          >
            {setup.secret}
          </code>
          <details className="mt-2 text-xs text-slate-500">
            <summary className="cursor-pointer">otpauth bağlantısı</summary>
            <code className="mt-1 block break-all">{setup.uri}</code>
          </details>
        </div>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Doğrulama uygulamanızdaki 6 haneli kodu girin.
        </p>
      )}
      <ActionForm action={platformMfaAction} submitLabel={setup ? "Doğrula ve etkinleştir" : "Giriş yap"}>
        <Field
          label="6 haneli kod"
          name="code"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          idPrefix="pm"
        />
      </ActionForm>
    </div>
  );
}
