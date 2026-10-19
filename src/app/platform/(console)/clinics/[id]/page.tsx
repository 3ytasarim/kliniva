import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CircleCheck } from "lucide-react";
import { requirePlatform } from "@/server/platform/guards";
import { listClinicOwners, listClinics } from "@/server/platform/clinics";
import { resetOwnerPasswordAction, setClinicStatusAction } from "@/app/actions/platform";
import { ActionForm, Field, InlineAction } from "@/components/action-form";
import { PageHeader, SectionCard } from "@/components/ui";
import { formatDateTime } from "@/components/patient-ui";

export const metadata: Metadata = { title: "Klinik · Platform" };

/** Klinik detayı: giriş bilgileri, durum (askıya al / etkinleştir), yönetici hesapları ve parola sıfırlama. */
export default async function PlatformClinicPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const p = await requirePlatform();
  const { id } = await params;
  const sp = await searchParams;
  const clinic = (await listClinics(p)).find((c) => c.id === id);
  if (!clinic) notFound();
  const owners = await listClinicOwners(p, id);
  const owner = owners[0];
  const loginId = owner?.username ?? owner?.email ?? "—";
  return (
    <section className="grid gap-6">
      <PageHeader
        title={clinic.name}
        description={`Klinik kodu ${clinic.slug}`}
        back={{ href: "/platform", label: "Klinikler" }}
      />

      {sp.created ? (
        <div
          role="status"
          data-testid="clinic-created"
          className="card flex items-start gap-3 border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/10"
        >
          <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden="true" />
          <div className="text-sm">
            <p className="font-semibold">Klinik oluşturuldu. Giriş bilgilerini yöneticiye iletin:</p>
            <dl className="mt-2 grid gap-1 sm:grid-cols-[10rem_1fr]">
              <dt className="text-slate-500">Klinik kodu</dt>
              <dd className="font-mono font-semibold">{clinic.slug}</dd>
              <dt className="text-slate-500">Kullanıcı adı / e-posta</dt>
              <dd className="font-mono font-semibold">{loginId}</dd>
              <dt className="text-slate-500">Parola</dt>
              <dd>Formda yazdığınız geçici parola (ilk girişte değiştirilecek)</dd>
            </dl>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Durum">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <dt className="text-slate-500">Durum</dt>
            <dd>
              {clinic.status === "ACTIVE" ? (
                <span className="badge badge-green">Aktif</span>
              ) : (
                <span className="badge badge-red">Askıda</span>
              )}
            </dd>
            <dt className="text-slate-500">Açılış</dt>
            <dd>{formatDateTime(clinic.createdAt)}</dd>
            <dt className="text-slate-500">Kullanıcı (aktif / toplam)</dt>
            <dd className="tabular-nums">
              {clinic.usersActive} / {clinic.usersTotal}
            </dd>
            <dt className="text-slate-500">Şube</dt>
            <dd className="tabular-nums">{clinic.branchesTotal}</dd>
            <dt className="text-slate-500">Hasta / randevu (30 gün)</dt>
            <dd className="tabular-nums">
              {clinic.patientsTotal} / {clinic.appointments30d}
            </dd>
          </dl>
          <div className="mt-4 border-t border-line pt-4 dark:border-line-dark">
            {clinic.status === "ACTIVE" ? (
              <InlineAction
                action={setClinicStatusAction}
                fields={{ id: clinic.id, status: "SUSPENDED" }}
                label="Kliniği askıya al"
                variant="danger"
                confirm="Klinik askıya alınsın mı? Tüm kullanıcıların oturumu kapanır ve giriş yapamazlar."
              />
            ) : (
              <InlineAction
                action={setClinicStatusAction}
                fields={{ id: clinic.id, status: "ACTIVE" }}
                label="Kliniği yeniden etkinleştir"
                variant="primary"
              />
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Klinik yöneticisi"
          description="Parola sıfırlanınca yönetici ilk girişte yenisini belirler."
        >
          {owners.length === 0 ? (
            <p className="text-sm text-slate-500">Yönetici hesabı yok.</p>
          ) : (
            <ul className="grid gap-4">
              {owners.map((o) => (
                <li key={o.userId} className="rounded-xl border border-line p-4 dark:border-line-dark">
                  <p className="font-medium">
                    {o.firstName} {o.lastName}
                    {!o.active ? <span className="badge badge-gray ml-2">Pasif</span> : null}
                    {o.mustChangePassword ? (
                      <span className="badge badge-amber ml-2">Geçici parola</span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-slate-500">
                    {[o.username, o.email].filter(Boolean).join(" · ")}
                  </p>
                  <p className="text-xs text-slate-500">
                    Son giriş: {o.lastLoginAt ? formatDateTime(o.lastLoginAt) : "henüz yok"}
                  </p>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium text-brand-700 dark:text-brand-300">
                      Parolayı sıfırla
                    </summary>
                    <ActionForm
                      action={resetOwnerPasswordAction}
                      submitLabel="Geçici parolayı kaydet"
                      className="mt-3 grid gap-3"
                    >
                      <input type="hidden" name="tenantId" value={clinic.id} />
                      <input type="hidden" name="userId" value={o.userId} />
                      <Field
                        label="Yeni geçici parola"
                        name="password"
                        type="password"
                        required
                        minLength={12}
                        autoComplete="new-password"
                        idPrefix={`rp-${o.userId.slice(0, 8)}`}
                      />
                    </ActionForm>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </section>
  );
}
