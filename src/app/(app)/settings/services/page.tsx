import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { listClinicalServices, listDoctorServices } from "@/server/services/clinical-services";
import { listDoctors } from "@/server/services/doctors";
import { ROOM_TYPES } from "@/server/services/org";
import {
  createServiceAction,
  setDoctorServicesAction,
  updateServiceAction,
} from "@/app/actions/appointments";
import { ActionForm, Field } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader, ROOM_TYPE_LABELS, StatusBadge } from "@/components/ui";

export const metadata: Metadata = { title: "Hizmetler" };

function ServiceFields({
  idPrefix,
  s,
}: {
  idPrefix: string;
  s?: {
    name: string;
    code: string | null;
    defaultDurationMinutes: number;
    requiresRoom: boolean;
    allowedRoomTypes: string[];
    active: boolean;
  };
}) {
  return (
    <>
      <Field label="Hizmet adı" name="name" required defaultValue={s?.name} idPrefix={idPrefix} />
      <Field label="Kod" name="code" defaultValue={s?.code ?? ""} idPrefix={idPrefix} maxLength={30} />
      <Field
        label="Varsayılan süre (dk)"
        name="defaultDurationMinutes"
        type="number"
        min={5}
        max={480}
        step={5}
        required
        defaultValue={String(s?.defaultDurationMinutes ?? 30)}
        idPrefix={idPrefix}
      />
      <fieldset className="sm:col-span-2">
        <legend className="label">Uygun oda tipleri (boş = tümü)</legend>
        <div className="flex flex-wrap gap-2">
          {ROOM_TYPES.map((t) => (
            <label
              key={t}
              className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700"
            >
              <input
                type="checkbox"
                name="allowedRoomTypes"
                value={t}
                defaultChecked={s?.allowedRoomTypes.includes(t)}
              />
              {ROOM_TYPE_LABELS[t]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input type="checkbox" name="requiresRoom" defaultChecked={s ? s.requiresRoom : true} />
        Oda gerektirir
      </label>
      {s ? (
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={s.active} />
          Aktif
        </label>
      ) : null}
    </>
  );
}

/** Klinik hizmetleri (işlem tipleri) ve doktorların verdiği hizmetler. */
export default async function ServicesPage({ searchParams }: { searchParams: Promise<{ doctor?: string }> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "service.manage")) return <Forbidden />;
  const sp = await searchParams;
  const services = await listClinicalServices(ctx);
  const doctors = hasPermission(ctx, "doctor.read") ? (await listDoctors(ctx)).filter((d) => d.active) : [];
  const doctorId = doctors.some((d) => d.id === sp.doctor) ? sp.doctor! : doctors[0]?.id;
  const offered = doctorId ? await listDoctorServices(ctx, doctorId) : [];
  const offeredMap = new Map(offered.map((o) => [o.id, o]));

  return (
    <section className="grid gap-6">
      <PageHeader
        title="Hizmetler"
        description="Randevu süresi ve oda gereksinimi hizmetten gelir; doktora özel süre tanımlanabilir."
      />

      <div className="card">
        <h2 className="mb-4 font-semibold">Yeni hizmet</h2>
        <ActionForm
          action={createServiceAction}
          submitLabel="Hizmet ekle"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <ServiceFields idPrefix="new" />
        </ActionForm>
      </div>

      {services.length === 0 ? (
        <EmptyState title="Henüz hizmet yok" />
      ) : (
        <div className="grid gap-3">
          {services.map((s) => (
            <details key={s.id} className="card">
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {s.name} <span className="text-sm text-slate-500">· {s.defaultDurationMinutes} dk</span>
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  {s.requiresRoom
                    ? s.allowedRoomTypes.length
                      ? s.allowedRoomTypes.map((t) => ROOM_TYPE_LABELS[t] ?? t).join(", ")
                      : "Herhangi bir oda"
                    : "Oda gerekmez"}
                  <StatusBadge active={s.active} />
                </span>
              </summary>
              <ActionForm
                action={updateServiceAction}
                submitLabel="Kaydet"
                className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              >
                <input type="hidden" name="id" value={s.id} />
                <ServiceFields idPrefix={`s-${s.id}`} s={s} />
              </ActionForm>
            </details>
          ))}
        </div>
      )}

      {doctors.length ? (
        <div className="card grid gap-4">
          <h2 className="font-semibold">Doktorun verdiği hizmetler</h2>
          <form className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="ds-doctor" className="label">
                Doktor
              </label>
              <select id="ds-doctor" name="doctor" defaultValue={doctorId} className="input">
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.displayName}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn-ghost">
              Seç
            </button>
          </form>
          {doctorId ? (
            <ActionForm
              action={setDoctorServicesAction}
              submitLabel="Doktorun hizmetlerini kaydet"
              className="grid gap-3"
            >
              <input type="hidden" name="doctorId" value={doctorId} />
              {services
                .filter((s) => s.active)
                .map((s) => (
                  <div
                    key={s.id}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700"
                  >
                    <label className="flex min-h-10 flex-1 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="serviceId"
                        value={s.id}
                        defaultChecked={offeredMap.has(s.id)}
                      />
                      {s.name} <span className="text-slate-500">({s.defaultDurationMinutes} dk)</span>
                    </label>
                    <div className="w-40">
                      <label htmlFor={`ov-${s.id}`} className="sr-only">
                        {s.name} için doktora özel süre
                      </label>
                      <input
                        id={`ov-${s.id}`}
                        name={`override_${s.id}`}
                        type="number"
                        min={5}
                        max={480}
                        step={5}
                        placeholder="Özel süre (dk)"
                        defaultValue={offeredMap.get(s.id)?.durationMinutesOverride ?? ""}
                        className="input"
                      />
                    </div>
                  </div>
                ))}
            </ActionForm>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
