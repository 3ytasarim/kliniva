import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { getClinicProfile } from "@/server/services/clinic";
import { ActionForm, Field, SelectField } from "@/components/action-form";
import { LogoUpload } from "@/components/logo-upload";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui";
import { saveClinicProfileAction, uploadLogoAction } from "@/app/actions/org";

export const metadata: Metadata = { title: "Klinik ayarları" };

const TIMEZONES = [
  "Europe/Istanbul",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Dubai",
  "Asia/Baku",
  "America/New_York",
];

export default async function ClinicSettingsPage() {
  const ctx = await requireUser();
  // Profil yönetimi kiracı geneli yönetimdir (servis de ayrıca doğrular).
  if (!hasPermission(ctx, "clinic.manage") || !ctx.branchScope.all) return <Forbidden />;
  const p = await getClinicProfile(ctx);

  return (
    <section className="max-w-4xl">
      <PageHeader
        title="Klinik profili"
        description="Hasta belgelerinde ve uygulamada görünen klinik bilgileri."
      />

      <div className="card mb-6">
        <LogoUpload action={uploadLogoAction} hasLogo={p.hasLogo} />
      </div>

      <div className="card">
        <ActionForm
          action={saveClinicProfileAction}
          submitLabel="Kaydet"
          className="grid gap-5 sm:grid-cols-2"
        >
          <Field label="Klinik adı" name="displayName" required defaultValue={p.displayName} />
          <Field
            label="Ticari unvan"
            name="legalName"
            defaultValue={p.legalName ?? ""}
            hint="KVKK belgelerinde veri sorumlusu olarak görünür."
          />
          <Field label="Telefon" name="phone" type="tel" defaultValue={p.phone ?? ""} />
          <Field label="E-posta" name="email" type="email" defaultValue={p.email ?? ""} />
          <Field
            label="Web sitesi"
            name="website"
            type="url"
            placeholder="https://"
            defaultValue={p.website ?? ""}
            className="sm:col-span-2"
          />
          <Field label="Adres" name="address" defaultValue={p.address ?? ""} className="sm:col-span-2" />
          <Field label="Şehir" name="city" defaultValue={p.city ?? ""} />
          <Field label="İlçe" name="district" defaultValue={p.district ?? ""} />
          <SelectField
            label="Saat dilimi"
            name="timezone"
            defaultValue={p.timezone}
            options={[...new Set([p.timezone, ...TIMEZONES])].map((tz) => ({ value: tz, label: tz }))}
          />
          <Field
            label="Varsayılan randevu süresi (dk)"
            name="defaultAppointmentDurationMinutes"
            type="number"
            min={5}
            max={480}
            step={5}
            defaultValue={p.defaultAppointmentDurationMinutes}
          />
          <Field
            label="SKT uyarı penceresi (gün)"
            name="expiryWarningDays"
            type="number"
            min={1}
            max={365}
            defaultValue={p.expiryWarningDays}
            hint="Son kullanma tarihine bu kadar gün kalan lotlar 'yaklaşan' olarak gösterilir."
          />
          <SelectField
            label="Randevu onay modu"
            name="appointmentApprovalMode"
            defaultValue={p.appointmentApprovalMode}
            options={[
              { value: "AUTO_ACCEPT", label: "Otomatik kabul (randevu doğrudan planlanır)" },
              {
                value: "DOCTOR_APPROVAL",
                label: "Doktor onayı (randevu onaylanana kadar bekler, slot tutulur)",
              },
            ]}
          />
          <input type="hidden" name="country" value={p.country} />
        </ActionForm>
      </div>
    </section>
  );
}
