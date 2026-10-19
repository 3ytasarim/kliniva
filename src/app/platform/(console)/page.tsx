import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requirePlatform } from "@/server/platform/guards";
import { listClinics } from "@/server/platform/clinics";
import { EmptyState, PageHeader, StatCard } from "@/components/ui";
import { formatDateTime } from "@/components/patient-ui";

export const metadata: Metadata = { title: "Klinikler · Platform" };

/** Platform: tüm klinikler (künye + kullanım sayıları; hasta içeriği yok). */
export default async function PlatformClinicsPage() {
  const p = await requirePlatform();
  const clinics = await listClinics(p);
  const active = clinics.filter((c) => c.status === "ACTIVE").length;
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Klinikler"
        description="Programı kullanan klinikler. Yeni klinik açın, askıya alın veya yönetici parolasını sıfırlayın."
        actions={
          <Link href="/platform/clinics/new" className="btn">
            <Plus className="size-4" aria-hidden="true" />
            Yeni klinik
          </Link>
        }
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Toplam klinik" value={clinics.length} icon="branch" tone="brand" />
        <StatCard label="Aktif" value={active} icon="check" tone="green" />
        <StatCard
          label="Askıda"
          value={clinics.length - active}
          icon="alert"
          tone={clinics.length - active ? "red" : "slate"}
        />
      </div>
      {clinics.length === 0 ? (
        <EmptyState title="Henüz klinik yok" icon="branch">
          <Link href="/platform/clinics/new" className="font-medium text-brand-700">
            İlk kliniği açın
          </Link>
        </EmptyState>
      ) : (
        <div className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Klinik</th>
                  <th>Klinik kodu</th>
                  <th>Durum</th>
                  <th className="text-right">Kullanıcı</th>
                  <th className="text-right">Hasta</th>
                  <th className="text-right">Randevu (30 gün)</th>
                  <th>Son giriş</th>
                </tr>
              </thead>
              <tbody>
                {clinics.map((c) => (
                  <tr key={c.id} data-testid="platform-clinic-row">
                    <td>
                      <Link href={`/platform/clinics/${c.id}`} className="font-medium hover:text-brand-700">
                        {c.name}
                      </Link>
                      <span className="block text-xs text-slate-500">
                        Açılış {formatDateTime(c.createdAt)}
                      </span>
                    </td>
                    <td className="font-mono text-sm">{c.slug}</td>
                    <td>
                      {c.status === "ACTIVE" ? (
                        <span className="badge badge-green">Aktif</span>
                      ) : (
                        <span className="badge badge-red">Askıda</span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">
                      {c.usersActive}/{c.usersTotal}
                    </td>
                    <td className="text-right tabular-nums">{c.patientsTotal}</td>
                    <td className="text-right tabular-nums">{c.appointments30d}</td>
                    <td className="whitespace-nowrap text-xs">
                      {c.lastLoginAt ? formatDateTime(c.lastLoginAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
