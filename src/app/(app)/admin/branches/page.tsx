import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { listBranchesWithStats } from "@/server/services/org";
import { ActionForm, Field, InlineAction } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { createBranchAction, toggleBranchAction } from "@/app/actions/org";

export const metadata: Metadata = { title: "Şubeler" };

export default async function BranchesPage() {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "branch.read")) return <Forbidden />;
  const rows = await listBranchesWithStats(ctx);
  const canManage = hasPermission(ctx, "branch.manage") && ctx.branchScope.all;

  return (
    <section>
      <PageHeader title="Şubeler" description="Klinik şubeleri, odalar, doktorlar ve çalışma saatleri." />

      {canManage ? (
        <div className="mb-6">
          <Panel summary="Yeni şube">
            <ActionForm
              action={createBranchAction}
              submitLabel="Şube oluştur"
              className="grid gap-4 sm:grid-cols-3"
            >
              <Field idPrefix="nb" label="Şube adı" name="name" required />
              <Field idPrefix="nb" label="Kod" name="code" placeholder="IST" hint="İsteğe bağlı, kısa kod." />
              <Field idPrefix="nb" label="Şehir" name="city" required />
              <Field idPrefix="nb" label="İlçe" name="district" />
              <Field idPrefix="nb" label="Telefon" name="phone" type="tel" />
              <Field idPrefix="nb" label="E-posta" name="email" type="email" />
              <Field idPrefix="nb" label="Adres" name="address" className="sm:col-span-3" />
            </ActionForm>
          </Panel>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState title="Henüz şube yok">İlk şubenizi ekleyerek başlayın.</EmptyState>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Şube</th>
                <th scope="col">Şehir</th>
                <th scope="col">Odalar</th>
                <th scope="col">Doktorlar</th>
                <th scope="col">Çalışma saatleri</th>
                <th scope="col">Durum</th>
                <th scope="col">
                  <span className="sr-only">İşlemler</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link href={`/admin/branches/${b.id}`} className="font-medium hover:text-brand-700">
                      {b.name}
                    </Link>
                    {b.code ? <span className="ml-2 font-mono text-xs text-slate-500">{b.code}</span> : null}
                  </td>
                  <td>
                    {b.city}
                    {b.district ? <span className="text-slate-500"> · {b.district}</span> : null}
                  </td>
                  <td>
                    <Link href={`/admin/rooms?branch=${b.id}`} className="hover:text-brand-700">
                      {b.roomCount}
                    </Link>
                  </td>
                  <td>{b.doctorCount}</td>
                  <td>
                    {b.workingHoursEnabled ? (
                      <span className="badge badge-brand">{b.openDays} gün açık</span>
                    ) : (
                      <span className="badge badge-gray">Tanımlı değil</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge active={b.active} />
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <div className="flex justify-end gap-2">
                      <Link href={`/admin/branches/${b.id}`} className="btn-ghost btn-sm">
                        {canManage ? "Düzenle" : "Görüntüle"}
                      </Link>
                      {canManage ? (
                        <InlineAction
                          action={toggleBranchAction}
                          fields={{ id: b.id, active: String(!b.active) }}
                          label={b.active ? "Pasifleştir" : "Aktifleştir"}
                          variant={b.active ? "danger" : "ghost"}
                          confirm={
                            b.active ? "Şube pasifleştirilsin mi? Doktor planları korunur." : undefined
                          }
                        />
                      ) : null}
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
