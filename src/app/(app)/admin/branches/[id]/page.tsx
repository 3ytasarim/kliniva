import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { getBranch, listBranchClosures } from "@/server/services/org";
import { ActionForm, Field, InlineAction } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { PageHeader, StatusBadge } from "@/components/ui";
import { DAYS, dateInZone, toHHMM } from "@/lib/time";
import {
  createClosureAction,
  deleteClosureAction,
  saveBranchHoursAction,
  updateBranchAction,
} from "@/app/actions/org";

export const metadata: Metadata = { title: "Şube" };

export default async function BranchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "branch.read")) return <Forbidden />;
  const { id } = await params;
  let branch: Awaited<ReturnType<typeof getBranch>>;
  try {
    branch = await getBranch(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const canManage = hasPermission(ctx, "branch.manage") && ctx.branchScope.all;
  const today = dateInZone(new Date(), branch.timezone);
  const closures = await listBranchClosures(ctx, id, today);
  const hourFor = (d: number) => branch.hours.find((h) => h.dayOfWeek === d);

  return (
    <section className="grid gap-6">
      <PageHeader
        back={{ href: "/admin/branches", label: "Şubeler" }}
        title={branch.name}
        description={[branch.city, branch.district].filter(Boolean).join(" · ")}
        actions={
          <>
            <StatusBadge active={branch.active} />
            <Link href={`/admin/rooms?branch=${branch.id}`} className="btn-ghost btn-sm">
              Odaları yönet
            </Link>
          </>
        }
      />

      <div className="card">
        <h2 className="mb-4 font-semibold">Şube bilgileri</h2>
        {canManage ? (
          <ActionForm action={updateBranchAction} submitLabel="Kaydet" className="grid gap-4 sm:grid-cols-3">
            <input type="hidden" name="id" value={branch.id} />
            <Field idPrefix="eb" label="Şube adı" name="name" required defaultValue={branch.name} />
            <Field idPrefix="eb" label="Kod" name="code" defaultValue={branch.code ?? ""} />
            <Field idPrefix="eb" label="Şehir" name="city" required defaultValue={branch.city} />
            <Field idPrefix="eb" label="İlçe" name="district" defaultValue={branch.district ?? ""} />
            <Field idPrefix="eb" label="Telefon" name="phone" type="tel" defaultValue={branch.phone ?? ""} />
            <Field
              idPrefix="eb"
              label="E-posta"
              name="email"
              type="email"
              defaultValue={branch.email ?? ""}
            />
            <Field
              idPrefix="eb"
              label="Adres"
              name="address"
              defaultValue={branch.address ?? ""}
              className="sm:col-span-2"
            />
            <Field idPrefix="eb" label="Saat dilimi" name="timezone" defaultValue={branch.timezone} />
          </ActionForm>
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-500">Adres</dt>
              <dd>{branch.address ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Telefon</dt>
              <dd>{branch.phone ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Saat dilimi</dt>
              <dd>{branch.timezone}</dd>
            </div>
          </dl>
        )}
      </div>

      <div className="card">
        <h2 className="font-semibold">Çalışma saatleri</h2>
        <p className="hint mb-4">
          Etkinse, doktorların müsaitliği şubenin açık olduğu saatlerle sınırlanır. Kapalı günlerde müsaitlik
          oluşmaz.
        </p>
        <ActionForm action={saveBranchHoursAction} submitLabel="Saatleri kaydet" className="grid gap-3">
          <input type="hidden" name="id" value={branch.id} />
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              name="workingHoursEnabled"
              defaultChecked={branch.workingHoursEnabled}
              disabled={!canManage}
              className="size-4"
            />
            Şube çalışma saatlerini müsaitlikte uygula
          </label>
          <div className="grid gap-2">
            {DAYS.map((d) => {
              const h = hourFor(d.iso);
              return (
                <fieldset
                  key={d.iso}
                  className="grid grid-cols-[110px_auto_1fr_1fr] items-center gap-3"
                  disabled={!canManage}
                >
                  <legend className="sr-only">{d.long}</legend>
                  <span className="text-sm font-medium">{d.long}</span>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name={`d${d.iso}_enabled`}
                      defaultChecked={h?.enabled ?? d.iso <= 5}
                      className="size-4"
                    />
                    Açık
                  </label>
                  <input
                    aria-label={`${d.long} açılış`}
                    type="time"
                    name={`d${d.iso}_start`}
                    defaultValue={h?.startTime ? toHHMM(h.startTime) : "09:00"}
                    className="input"
                  />
                  <input
                    aria-label={`${d.long} kapanış`}
                    type="time"
                    name={`d${d.iso}_end`}
                    defaultValue={h?.endTime ? toHHMM(h.endTime) : "18:00"}
                    className="input"
                  />
                </fieldset>
              );
            })}
          </div>
        </ActionForm>
      </div>

      <div className="card">
        <h2 className="font-semibold">Kapalı günler</h2>
        <p className="hint mb-4">
          Resmi tatiller, yarım günler. Bu tarihlerde (veya saatlerde) müsaitlik oluşmaz.
        </p>
        {closures.length ? (
          <ul className="mb-4 divide-y divide-slate-100 dark:divide-slate-800">
            {closures.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <span className="font-medium">{c.date}</span>{" "}
                  {c.allDay ? (
                    <span className="badge badge-amber">Tüm gün kapalı</span>
                  ) : (
                    <span className="badge badge-amber">
                      {toHHMM(c.startTime!)}–{toHHMM(c.endTime!)} kapalı
                    </span>
                  )}
                  {c.reason ? <span className="ml-2 text-slate-500">{c.reason}</span> : null}
                </span>
                {canManage ? (
                  <InlineAction
                    action={deleteClosureAction}
                    fields={{ id: c.id }}
                    label="Sil"
                    variant="danger"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-4 text-sm text-slate-500">Yaklaşan kapalı gün yok.</p>
        )}
        {canManage ? (
          <ActionForm
            action={createClosureAction}
            submitLabel="Kapalı gün ekle"
            className="grid gap-4 sm:grid-cols-5"
          >
            <input type="hidden" name="branchId" value={branch.id} />
            <Field idPrefix="cl" label="Tarih" name="date" type="date" required min={today} />
            <label className="flex items-center gap-2 self-end pb-3 text-sm">
              <input type="checkbox" name="allDay" defaultChecked className="size-4" /> Tüm gün
            </label>
            <Field idPrefix="cl" label="Başlangıç" name="startTime" type="time" hint="Tüm gün değilse" />
            <Field idPrefix="cl" label="Bitiş" name="endTime" type="time" />
            <Field idPrefix="cl" label="Neden" name="reason" placeholder="29 Ekim" />
          </ActionForm>
        ) : null}
      </div>
    </section>
  );
}
