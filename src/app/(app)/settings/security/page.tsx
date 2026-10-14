import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { MFA_REQUIRED_ROLES } from "@/server/auth/permissions";
import { ActionForm } from "@/components/action-form";
import { MfaEnrollment } from "@/components/mfa-enrollment";
import { revokeOtherSessionsAction } from "@/app/actions/admin";

export const metadata: Metadata = { title: "Güvenlik" };

export default async function SecuritySettingsPage() {
  const ctx = await requireUser();
  const mfaRecommended = ctx.roles.some((r) => MFA_REQUIRED_ROLES.includes(r));
  return (
    <section className="grid max-w-2xl gap-6">
      <h1 className="text-2xl font-bold">Güvenlik</h1>

      <div className="card">
        <h2 className="font-semibold">İki adımlı doğrulama (TOTP)</h2>
        {ctx.user.twoFactorEnabled ? (
          <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">
            Hesabınızda iki adımlı doğrulama etkin.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Hasta sağlık verisine erişen hesaplar için iki adımlı doğrulama önerilir
              {mfaRecommended ? " — rolünüz için ileride zorunlu olacaktır" : ""}.
            </p>
            <MfaEnrollment />
          </>
        )}
      </div>

      <div className="card">
        <h2 className="font-semibold">Oturumlar</h2>
        <p className="mb-4 mt-2 text-sm text-slate-600 dark:text-slate-400">
          Bu cihaz dışındaki tüm oturumları sunucuda sonlandırır.
        </p>
        <ActionForm action={revokeOtherSessionsAction} submitLabel="Diğer oturumları kapat">
          {null}
        </ActionForm>
      </div>
    </section>
  );
}
