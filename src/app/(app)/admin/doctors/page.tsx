import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { listDoctorCandidates, listDoctors } from "@/server/services/doctors";
import { ActionForm, Field, SelectField } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { createDoctorAction } from "@/app/actions/org";
import { DAYS, dateInZone, isoDayOfWeek } from "@/lib/time";

export const metadata: Metadata = { title: "Doktorlar" };

/** Haftalık çalışma günlerinden bir sonraki çalışma gününü hesaplar (izinler doktor detayında). */
function nextWorkingDay(days: number[], today: string): string | null {
  if (!days.length) return null;
  const t = isoDayOfWeek(today);
  for (let i = 0; i < 7; i++) {
    const d = ((t - 1 + i) % 7) + 1;
    if (days.includes(d)) return i === 0 ? "Bugün" : i === 1 ? "Yarın" : DAYS[d - 1]!.long;
  }
  return null;
}

export default async function DoctorsPage() {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "doctor.read")) return <Forbidden />;
  const doctors = await listDoctors(ctx);
  const canManage = hasPermission(ctx, "doctor.manage") && ctx.branchScope.all;
  const candidates = canManage ? await listDoctorCandidates(ctx) : [];
  const today = dateInZone(new Date(), "Europe/Istanbul");

  const profileFields = (p: string) => (
    <>
      <Field idPrefix={p} label="Unvan" name="title" placeholder="Dr., Uzm. Dr., Doç. Dr." />
      <Field idPrefix={p} label="Uzmanlık" name="specialty" required placeholder="Dermatoloji" />
      <Field idPrefix={p} label="Yan dal" name="subSpecialty" />
      <Field idPrefix={p} label="Diploma / tescil no" name="licenseNumber" />
      <Field
        idPrefix={p}
        label="Varsayılan randevu süresi (dk)"
        name="defaultAppointmentDurationMinutes"
        type="number"
        min={5}
        max={480}
        step={5}
        defaultValue={30}
      />
    </>
  );

  return (
    <section>
      <PageHeader
        title="Doktorlar"
        description="Doktor profilleri, şube atamaları ve haftalık çalışma planları."
        actions={
          canManage ? (
            <div className="flex flex-wrap items-start gap-2">
              <Panel summary="Yeni doktor (yeni kullanıcı)">
                <ActionForm
                  action={createDoctorAction}
                  submitLabel="Doktoru oluştur"
                  className="grid gap-4 sm:grid-cols-2"
                >
                  <input type="hidden" name="mode" value="new" />
                  <Field idPrefix="nd" label="Ad" name="firstName" required />
                  <Field idPrefix="nd" label="Soyad" name="lastName" required />
                  <Field
                    idPrefix="nd"
                    label="E-posta"
                    name="email"
                    type="email"
                    required
                    autoComplete="off"
                  />
                  <Field idPrefix="nd" label="Telefon" name="phone" type="tel" />
                  <Field
                    idPrefix="nd"
                    label="Geçici parola"
                    name="password"
                    type="password"
                    required
                    autoComplete="new-password"
                    hint="12+ karakter, harf ve rakam."
                  />
                  {profileFields("nd")}
                </ActionForm>
              </Panel>
              {candidates.length ? (
                <Panel summary="Mevcut kullanıcıyı doktor yap" variant="ghost">
                  <ActionForm
                    action={createDoctorAction}
                    submitLabel="Doktor profili oluştur"
                    className="grid gap-4 sm:grid-cols-2"
                  >
                    <input type="hidden" name="mode" value="existing" />
                    <SelectField
                      idPrefix="ed"
                      label="Kullanıcı"
                      name="userId"
                      required
                      className="sm:col-span-2"
                      options={candidates.map((c) => ({
                        value: c.id,
                        label: `${c.firstName} ${c.lastName} · ${c.email}${c.isDoctorRole ? "" : " (DOCTOR rolü eklenecek)"}`,
                      }))}
                    />
                    {profileFields("ed")}
                  </ActionForm>
                </Panel>
              ) : null}
            </div>
          ) : null
        }
      />

      {doctors.length === 0 ? (
        <EmptyState title="Henüz doktor yok">
          Doktor ekleyip şubelere atadığınızda burada listelenir.
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Doktor</th>
                <th scope="col">Uzmanlık</th>
                <th scope="col">Şubeler</th>
                <th scope="col">Sonraki çalışma günü</th>
                <th scope="col">Durum</th>
                <th scope="col">
                  <span className="sr-only">İşlemler</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {doctors.map((d) => (
                <tr key={d.id}>
                  <td className="font-medium">
                    <Link href={`/admin/doctors/${d.id}`} className="hover:text-brand-700">
                      {d.displayName}
                    </Link>
                  </td>
                  <td>{d.specialty}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {d.branches.length ? (
                        d.branches.map((b) => (
                          <span key={b.id} className={`badge ${b.active ? "badge-brand" : "badge-gray"}`}>
                            {b.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </div>
                  </td>
                  <td>
                    {nextWorkingDay(d.workingDays, today) ?? <span className="text-slate-500">Plan yok</span>}
                  </td>
                  <td>
                    <StatusBadge active={d.active} />
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <div className="flex justify-end gap-2">
                      <Link href={`/admin/doctors/${d.id}`} className="btn-ghost btn-sm">
                        Profil
                      </Link>
                      <Link href={`/admin/doctors/${d.id}/schedule`} className="btn btn-sm">
                        Plan
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
