import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { getDoctor } from "@/server/services/doctors";
import { accessibleBranchOptions } from "@/server/services/org";
import { ActionForm, Field, InlineAction, SelectField } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { PageHeader, StatusBadge } from "@/components/ui";
import { assignDoctorBranchAction, removeDoctorBranchAction, updateDoctorAction } from "@/app/actions/org";

export const metadata: Metadata = { title: "Doktor profili" };

export default async function DoctorProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "doctor.read")) return <Forbidden />;
  const { id } = await params;
  let doctor: Awaited<ReturnType<typeof getDoctor>>;
  try {
    doctor = await getDoctor(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const canManage = hasPermission(ctx, "doctor.manage") && ctx.branchScope.all;
  const branchOptions = canManage ? await accessibleBranchOptions(ctx) : [];
  const unassigned = branchOptions.filter((b) => !doctor.branches.some((x) => x.id === b.id && x.active));

  return (
    <section className="grid max-w-4xl gap-6">
      <PageHeader
        back={{ href: "/admin/doctors", label: "Doktorlar" }}
        title={doctor.displayName}
        description={`${doctor.specialty}${doctor.subSpecialty ? ` · ${doctor.subSpecialty}` : ""}`}
        actions={
          <>
            <StatusBadge active={doctor.active} />
            <Link href={`/admin/doctors/${doctor.id}/schedule`} className="btn btn-sm">
              Çalışma planı
            </Link>
          </>
        }
      />

      <div className="card">
        <h2 className="mb-4 font-semibold">Profil</h2>
        {canManage ? (
          <ActionForm action={updateDoctorAction} submitLabel="Kaydet" className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="id" value={doctor.id} />
            <Field idPrefix="dp" label="Unvan" name="title" defaultValue={doctor.title ?? ""} />
            <Field idPrefix="dp" label="Uzmanlık" name="specialty" required defaultValue={doctor.specialty} />
            <Field
              idPrefix="dp"
              label="Yan dal"
              name="subSpecialty"
              defaultValue={doctor.subSpecialty ?? ""}
            />
            <Field
              idPrefix="dp"
              label="Diploma / tescil no"
              name="licenseNumber"
              defaultValue={doctor.licenseNumber ?? ""}
            />
            <Field
              idPrefix="dp"
              label="Varsayılan randevu süresi (dk)"
              name="defaultAppointmentDurationMinutes"
              type="number"
              min={5}
              max={480}
              step={5}
              defaultValue={doctor.defaultAppointmentDurationMinutes}
            />
            <SelectField
              idPrefix="dp"
              label="Durum"
              name="active"
              defaultValue={String(doctor.active)}
              options={[
                { value: "true", label: "Aktif" },
                { value: "false", label: "Pasif" },
              ]}
            />
            <div className="sm:col-span-2">
              <label htmlFor="dp-bio" className="label">
                Biyografi
              </label>
              <textarea id="dp-bio" name="bio" rows={3} defaultValue={doctor.bio ?? ""} className="input" />
            </div>
          </ActionForm>
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">E-posta</dt>
              <dd>{doctor.email}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Varsayılan süre</dt>
              <dd>{doctor.defaultAppointmentDurationMinutes} dk</dd>
            </div>
          </dl>
        )}
      </div>

      <div className="card">
        <h2 className="mb-1 font-semibold">Şubeler</h2>
        <p className="hint mb-4">
          Doktor yalnızca atandığı şubelerde planlanabilir. Şube bağı kaldırılırsa o şubedeki plan ve oda
          atamaları da silinir.
        </p>
        <ul className="mb-4 divide-y divide-slate-100 dark:divide-slate-800">
          {doctor.branches.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="font-medium">
                {b.name} {!b.active ? <span className="badge badge-gray ml-2">Pasif</span> : null}
              </span>
              {canManage ? (
                <InlineAction
                  action={removeDoctorBranchAction}
                  fields={{ doctorId: doctor.id, branchId: b.id }}
                  label="Kaldır"
                  variant="danger"
                  confirm={`${b.name} bağı ve bu şubedeki plan kaldırılsın mı?`}
                />
              ) : null}
            </li>
          ))}
          {!doctor.branches.length ? (
            <li className="py-2 text-sm text-slate-500">Atanmış şube yok.</li>
          ) : null}
        </ul>
        {canManage && unassigned.length ? (
          <ActionForm
            action={assignDoctorBranchAction}
            submitLabel="Şubeye ata"
            className="flex flex-wrap items-end gap-3"
          >
            <input type="hidden" name="doctorId" value={doctor.id} />
            <SelectField
              idPrefix="ab"
              label="Şube"
              name="branchId"
              required
              options={unassigned.map((b) => ({ value: b.id, label: b.name }))}
            />
          </ActionForm>
        ) : null}
      </div>
    </section>
  );
}
