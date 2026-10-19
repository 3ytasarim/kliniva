import type { Metadata } from "next";
import { platformLoginAction } from "@/app/actions/platform";
import { ActionForm, Field } from "@/components/action-form";

export const metadata: Metadata = { title: "Platform girişi" };

/** Platform yöneticisi girişi (klinik kodu yok). Parolanın ardından iki adımlı doğrulama zorunludur. */
export default function PlatformLoginPage() {
  return (
    <div className="card p-6">
      <ActionForm action={platformLoginAction} submitLabel="Devam et">
        <Field label="E-posta" name="email" type="email" required autoComplete="username" idPrefix="pl" />
        <Field
          label="Parola"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          idPrefix="pl"
        />
      </ActionForm>
    </div>
  );
}
