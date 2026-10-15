import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { getPatient } from "@/server/services/patients";
import { accessibleBranchOptions } from "@/server/services/org";
import { updatePatientAction } from "@/app/actions/patients";
import { ActionForm, Field, SelectField } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Hasta düzenle" };

const GENDERS = [
  { value: "FEMALE", label: "Kadın" },
  { value: "MALE", label: "Erkek" },
  { value: "OTHER", label: "Diğer" },
  { value: "UNDISCLOSED", label: "Belirtmek istemiyor" },
];
const LANGUAGES = ["TR", "EN", "DE", "AR", "RU", "FR"].map((l) => ({ value: l, label: l }));

/** Kimlik / iletişim düzenleme. İmzalı belgeler bu işlemden etkilenmez (belgelerde imza anındaki snapshot kalır). */
export default async function EditPatientPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "patient.update")) return <Forbidden />;
  const { id } = await params;
  let p: Awaited<ReturnType<typeof getPatient>>;
  try {
    p = await getPatient(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const branches = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];

  return (
    <section className="max-w-4xl">
      <PageHeader
        title="Hasta bilgilerini düzenle"
        description={`${p.firstName} ${p.lastName} · ${p.patientNumber}`}
        back={{ href: `/patients/${p.id}`, label: "Hasta dosyası" }}
      />
      <div className="card">
        <ActionForm action={updatePatientAction} submitLabel="Kaydet" className="grid gap-5 sm:grid-cols-2">
          <input type="hidden" name="id" value={p.id} />
          <Field label="Ad" name="firstName" required defaultValue={p.firstName} idPrefix="pe" />
          <Field label="Soyad" name="lastName" required defaultValue={p.lastName} idPrefix="pe" />
          <Field label="Telefon" name="phone" type="tel" required defaultValue={p.phone} idPrefix="pe" />
          <Field
            label="İkinci telefon"
            name="secondaryPhone"
            type="tel"
            defaultValue={p.secondaryPhone ?? ""}
            idPrefix="pe"
          />
          <Field label="E-posta" name="email" type="email" defaultValue={p.email ?? ""} idPrefix="pe" />
          <Field
            label="Doğum tarihi"
            name="birthDate"
            type="date"
            defaultValue={p.birthDate ?? ""}
            idPrefix="pe"
          />
          <SelectField
            label="Cinsiyet"
            name="gender"
            options={GENDERS}
            defaultValue={p.gender ?? ""}
            placeholder="Belirtilmedi"
            idPrefix="pe"
          />
          <SelectField
            label="Tercih edilen dil"
            name="preferredLanguage"
            options={LANGUAGES}
            defaultValue={p.preferredLanguage}
            idPrefix="pe"
          />
          {branches.length ? (
            <SelectField
              label="Ana şube"
              name="primaryBranchId"
              options={branches.map((b) => ({ value: b.id, label: b.name }))}
              defaultValue={p.primaryBranchId ?? ""}
              placeholder="Seçin"
              idPrefix="pe"
            />
          ) : null}
          <Field
            label="Uyruk (ISO, 2 harf)"
            name="nationality"
            maxLength={2}
            defaultValue={p.nationality ?? ""}
            idPrefix="pe"
          />
          <Field
            label="TC kimlik no"
            name="nationalId"
            inputMode="numeric"
            autoComplete="off"
            placeholder={p.nationalIdMasked ?? ""}
            hint="Boş bırakılırsa değişmez. Değer şifreli saklanır ve tam hali gösterilmez."
            idPrefix="pe"
          />
          <Field
            label="Adres"
            name="address"
            defaultValue={p.address ?? ""}
            idPrefix="pe"
            className="sm:col-span-2"
          />
          <Field label="Şehir" name="city" defaultValue={p.city ?? ""} idPrefix="pe" />
          <Field label="İlçe" name="district" defaultValue={p.district ?? ""} idPrefix="pe" />
          <Field
            label="Acil durumda aranacak kişi"
            name="emergencyContactName"
            defaultValue={p.emergencyContactName ?? ""}
            idPrefix="pe"
          />
          <Field
            label="Acil durum telefonu"
            name="emergencyContactPhone"
            type="tel"
            defaultValue={p.emergencyContactPhone ?? ""}
            idPrefix="pe"
          />
        </ActionForm>
      </div>
    </section>
  );
}
