import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { getDoctorSchedule } from "@/server/services/schedule";
import { listRooms } from "@/server/services/org";
import { ActionForm, Field, InlineAction, SelectField } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui";
import { WeekCalendar, type CalendarBlock } from "@/components/week-calendar";
import { DAYS, dayName, parseTime } from "@/lib/time";
import {
  addExceptionAction,
  addRoomAssignmentAction,
  addWorkingHourAction,
  changeAssignmentRoomAction,
  deleteExceptionAction,
  deleteRoomAssignmentAction,
  deleteWorkingHourAction,
  updateWorkingHourAction,
} from "@/app/actions/org";

export const metadata: Metadata = { title: "Çalışma planı" };

const dayOptions = DAYS.map((d) => ({ value: String(d.iso), label: d.long }));

export default async function DoctorSchedulePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "doctor.schedule.read") && !hasPermission(ctx, "doctor.self.read"))
    return <Forbidden />;
  const { id } = await params;
  let schedule: Awaited<ReturnType<typeof getDoctorSchedule>>;
  try {
    schedule = await getDoctorSchedule(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN")) notFound();
    throw e;
  }
  const { doctor, working, assignments, exceptions, today } = schedule;
  const canManage = hasPermission(ctx, "doctor.schedule.manage");
  const branches = doctor.branches.filter((b) => b.active);
  const branchIds = branches.map((b) => b.id);
  const rooms =
    canManage && branchIds.length ? (await listRooms(ctx)).filter((r) => branchIds.includes(r.branchId)) : [];
  const roomOptions = rooms.map((r) => ({ value: r.id, label: `${r.branchName} · ${r.name}` }));
  const branchOptions = branches.map((b) => ({ value: b.id, label: b.name }));

  const weekly = assignments.filter((a) => a.dayOfWeek !== null);
  const dated = assignments.filter((a) => a.effectiveDate !== null);
  const blocks: CalendarBlock[] = working.map((w) => {
    const ws = parseTime(w.startTime)!;
    const we = parseTime(w.endTime)!;
    return {
      ...w,
      rooms: weekly
        .filter(
          (a) =>
            a.dayOfWeek === w.dayOfWeek &&
            a.branchId === w.branchId &&
            parseTime(a.startTime)! >= ws &&
            parseTime(a.endTime)! <= we,
        )
        .map((a) => ({ name: a.roomName, startTime: a.startTime, endTime: a.endTime })),
    };
  });
  const roomOf = (blockDay: number, branchId: string, s: string, e: string) =>
    weekly.filter(
      (a) =>
        a.dayOfWeek === blockDay &&
        a.branchId === branchId &&
        parseTime(a.startTime)! >= parseTime(s)! &&
        parseTime(a.endTime)! <= parseTime(e)!,
    );

  return (
    <section className="grid gap-6">
      <PageHeader
        back={{ href: `/admin/doctors/${doctor.id}`, label: doctor.displayName }}
        title="Haftalık çalışma planı"
        description={`${doctor.displayName} · ${doctor.specialty}`}
      />

      {!branches.length ? (
        <div className="card text-sm">
          Doktor henüz bir şubeye atanmamış.{" "}
          <Link href={`/admin/doctors/${doctor.id}`} className="font-medium text-brand-700">
            Şube ata
          </Link>
        </div>
      ) : null}

      <div className="card">
        <WeekCalendar blocks={blocks} branchOrder={branchIds} />
      </div>

      {canManage && branches.length ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="card">
            <h2 className="font-semibold">Çalışma bloğu ekle</h2>
            <p className="hint mb-4">
              Aynı gün birden fazla blok eklenebilir (ör. 09:00–12:00 ve 13:00–17:00). Doktorun aynı saatte
              başka bir şubede bloğu varsa sunucu reddeder. Oda seçerseniz bloğun tamamı için oda ataması da
              yapılır.
            </p>
            <ActionForm
              action={addWorkingHourAction}
              submitLabel="Bloğu ekle"
              className="grid gap-4 sm:grid-cols-2"
            >
              <input type="hidden" name="doctorId" value={doctor.id} />
              <SelectField idPrefix="wh" label="Şube" name="branchId" required options={branchOptions} />
              <SelectField idPrefix="wh" label="Gün" name="dayOfWeek" required options={dayOptions} />
              <Field
                idPrefix="wh"
                label="Başlangıç"
                name="startTime"
                type="time"
                required
                defaultValue="09:00"
                step={300}
              />
              <Field
                idPrefix="wh"
                label="Bitiş"
                name="endTime"
                type="time"
                required
                defaultValue="17:00"
                step={300}
              />
              <SelectField
                idPrefix="wh"
                label="Oda (isteğe bağlı)"
                name="roomId"
                placeholder="Oda atama"
                options={roomOptions}
                className="sm:col-span-2"
              />
            </ActionForm>
          </div>

          <div className="card">
            <h2 className="font-semibold">Oda ataması</h2>
            <p className="hint mb-4">
              Haftalık tekrar için gün, tek bir tarih için tarih seçin (tarih, o günün haftalık atamasının
              yerine geçer). Atama, doktorun o şubedeki çalışma saatleri içinde olmalıdır.
            </p>
            <ActionForm
              action={addRoomAssignmentAction}
              submitLabel="Odayı ata"
              className="grid gap-4 sm:grid-cols-2"
            >
              <input type="hidden" name="doctorId" value={doctor.id} />
              <SelectField idPrefix="ra" label="Şube" name="branchId" required options={branchOptions} />
              <SelectField idPrefix="ra" label="Oda" name="roomId" required options={roomOptions} />
              <SelectField
                idPrefix="ra"
                label="Haftalık gün"
                name="dayOfWeek"
                placeholder="—"
                options={dayOptions}
              />
              <Field idPrefix="ra" label="veya tarih" name="effectiveDate" type="date" min={today} />
              <Field
                idPrefix="ra"
                label="Başlangıç"
                name="startTime"
                type="time"
                required
                defaultValue="09:00"
                step={300}
              />
              <Field
                idPrefix="ra"
                label="Bitiş"
                name="endTime"
                type="time"
                required
                defaultValue="12:00"
                step={300}
              />
            </ActionForm>
          </div>
        </div>
      ) : null}

      <div className="card overflow-x-auto p-0">
        <h2 className="px-5 pt-5 font-semibold">Çalışma blokları</h2>
        <table className="table mt-2">
          <thead>
            <tr>
              <th scope="col">Gün</th>
              <th scope="col">Saat</th>
              <th scope="col">Şube</th>
              <th scope="col">Oda</th>
              {canManage ? (
                <th scope="col">
                  <span className="sr-only">İşlemler</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {working.map((w) => {
              const blockRooms = roomOf(w.dayOfWeek, w.branchId, w.startTime, w.endTime);
              return (
                <tr key={w.id}>
                  <td>{dayName(w.dayOfWeek)}</td>
                  <td className="font-mono text-xs">
                    {w.startTime}–{w.endTime}
                  </td>
                  <td>{w.branchName}</td>
                  <td>
                    {blockRooms.length ? (
                      <ul className="grid gap-2">
                        {blockRooms.map((a) => (
                          <li key={a.id} className="flex flex-wrap items-center gap-2">
                            <span className="badge badge-brand">
                              {a.roomName} · {a.startTime}–{a.endTime}
                            </span>
                            {canManage ? (
                              <>
                                <details className="panel">
                                  <summary className="btn-ghost btn-sm">Odayı değiştir</summary>
                                  <ActionForm
                                    action={changeAssignmentRoomAction}
                                    submitLabel="Değiştir"
                                    className="mt-2 grid gap-2"
                                  >
                                    <input type="hidden" name="id" value={a.id} />
                                    <input type="hidden" name="doctorId" value={doctor.id} />
                                    <SelectField
                                      idPrefix={`cr-${a.id}`}
                                      label="Yeni oda"
                                      name="roomId"
                                      defaultValue={a.roomId}
                                      options={roomOptions.filter(
                                        (o) => rooms.find((r) => r.id === o.value)?.branchId === w.branchId,
                                      )}
                                    />
                                  </ActionForm>
                                </details>
                                <InlineAction
                                  action={deleteRoomAssignmentAction}
                                  fields={{ id: a.id, doctorId: doctor.id }}
                                  label="Odayı kaldır"
                                  variant="danger"
                                />
                              </>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-slate-500">Oda atanmamış</span>
                    )}
                  </td>
                  {canManage ? (
                    <td className="whitespace-nowrap">
                      <div className="flex flex-wrap justify-end gap-2">
                        <details className="panel">
                          <summary className="btn-ghost btn-sm">Saati düzenle</summary>
                          <ActionForm
                            action={updateWorkingHourAction}
                            submitLabel="Kaydet"
                            className="mt-2 grid grid-cols-2 gap-2"
                          >
                            <input type="hidden" name="id" value={w.id} />
                            <input type="hidden" name="doctorId" value={doctor.id} />
                            <Field
                              idPrefix={`uw-${w.id}`}
                              label="Başlangıç"
                              name="startTime"
                              type="time"
                              required
                              defaultValue={w.startTime}
                            />
                            <Field
                              idPrefix={`uw-${w.id}`}
                              label="Bitiş"
                              name="endTime"
                              type="time"
                              required
                              defaultValue={w.endTime}
                            />
                          </ActionForm>
                        </details>
                        <InlineAction
                          action={deleteWorkingHourAction}
                          fields={{ id: w.id, doctorId: doctor.id }}
                          label="Sil"
                          variant="danger"
                          confirm="Blok ve içindeki haftalık oda atamaları silinsin mi?"
                        />
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {!working.length ? (
              <tr>
                <td colSpan={canManage ? 5 : 4} className="text-slate-500">
                  Henüz çalışma bloğu yok.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {dated.length ? (
        <div className="card">
          <h2 className="mb-3 font-semibold">Tarihli oda atamaları</h2>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {dated.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <span className="font-medium">{a.effectiveDate}</span> · {a.startTime}–{a.endTime} ·{" "}
                  <span className="badge badge-brand">{a.roomName}</span>
                </span>
                {canManage ? (
                  <InlineAction
                    action={deleteRoomAssignmentAction}
                    fields={{ id: a.id, doctorId: doctor.id }}
                    label="Sil"
                    variant="danger"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="card">
        <h2 className="font-semibold">İzinler ve çalışmama günleri</h2>
        <p className="hint mb-4">Bu kayıtlar müsaitlik hesabında çalışma saatlerinden düşülür.</p>
        <ul className="mb-4 divide-y divide-slate-100 dark:divide-slate-800">
          {exceptions.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span>
                <span className="font-medium">{x.date}</span>{" "}
                <span className="badge badge-amber">
                  {x.type === "ALL_DAY" ? "Tüm gün" : `${x.startTime}–${x.endTime}`}
                </span>
                {x.reason ? <span className="ml-2 text-slate-500">{x.reason}</span> : null}
              </span>
              {canManage ? (
                <InlineAction
                  action={deleteExceptionAction}
                  fields={{ id: x.id, doctorId: doctor.id }}
                  label="Sil"
                  variant="danger"
                />
              ) : null}
            </li>
          ))}
          {!exceptions.length ? (
            <li className="py-2 text-sm text-slate-500">Yaklaşan izin kaydı yok.</li>
          ) : null}
        </ul>
        {canManage ? (
          <ActionForm
            action={addExceptionAction}
            submitLabel="Kaydı ekle"
            className="grid gap-4 sm:grid-cols-3"
          >
            <input type="hidden" name="doctorId" value={doctor.id} />
            <Field idPrefix="ex" label="Tarih" name="date" type="date" required min={today} />
            <SelectField
              idPrefix="ex"
              label="Tür"
              name="type"
              defaultValue="ALL_DAY"
              options={[
                { value: "ALL_DAY", label: "Tüm gün" },
                { value: "TIME_RANGE", label: "Saat aralığı" },
              ]}
            />
            <SelectField
              idPrefix="ex"
              label="Şube"
              name="branchId"
              placeholder="Tüm şubeler"
              options={branchOptions}
            />
            <Field
              idPrefix="ex"
              label="Başlangıç"
              name="startTime"
              type="time"
              hint="Yalnızca saat aralığı için"
            />
            <Field idPrefix="ex" label="Bitiş" name="endTime" type="time" />
            <Field idPrefix="ex" label="Neden" name="reason" placeholder="Yıllık izin" />
          </ActionForm>
        ) : null}
      </div>
    </section>
  );
}
