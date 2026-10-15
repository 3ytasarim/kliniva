import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { listPatients } from "@/server/services/patients";
import { accessibleBranchOptions } from "@/server/services/org";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { PrivacyBadge, formatDateTime } from "@/components/patient-ui";

export const metadata: Metadata = { title: "Hastalar" };

type Search = { q?: string; branch?: string; status?: string; page?: string };

/**
 * Hasta listesi — sunucu tarafı arama + sayfalama (varsayılan 25). Minimum veri: maskeli telefon; sağlık verisi
 * listede asla yer almaz. KVKK durumu belgelerden türetilir.
 */
export default async function PatientsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "patient.read")) return <Forbidden />;
  const sp = await searchParams;
  const status = sp.status === "inactive" || sp.status === "all" ? sp.status : "active";
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);
  const branches = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];

  let result: Awaited<ReturnType<typeof listPatients>> = { items: [], total: 0, page, limit: 25 };
  let searchError: string | null = null;
  try {
    result = await listPatients(ctx, { q: sp.q, branchId: sp.branch, status, page });
  } catch (e) {
    if (isAppError(e) && e.code === "VALIDATION") searchError = e.message;
    else throw e;
  }
  const pages = Math.max(Math.ceil(result.total / result.limit), 1);
  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (sp.q) u.set("q", sp.q);
    if (sp.branch) u.set("branch", sp.branch);
    if (status !== "active") u.set("status", status);
    u.set("page", String(p));
    return `/patients?${u.toString()}`;
  };

  return (
    <section>
      <PageHeader
        title="Hastalar"
        description={`${result.total} kayıt`}
        actions={
          hasPermission(ctx, "patient.create") ? (
            <Link href="/patients/new" className="btn">
              + Yeni hasta
            </Link>
          ) : null
        }
      />

      <form
        role="search"
        className="card mb-6 grid gap-3 sm:grid-cols-2 sm:items-end xl:grid-cols-[minmax(0,1fr)_200px_160px_auto]"
      >
        <div>
          <label htmlFor="q" className="label">
            Ara
          </label>
          <input
            id="q"
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Ad, soyad, hasta no, telefon veya e-posta"
            className="input"
            minLength={2}
            maxLength={100}
          />
        </div>
        <div>
          <label htmlFor="branch" className="label">
            Şube
          </label>
          <select id="branch" name="branch" defaultValue={sp.branch ?? ""} className="input">
            <option value="">Tüm şubeler</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="status" className="label">
            Durum
          </label>
          <select id="status" name="status" defaultValue={status} className="input">
            <option value="active">Aktif</option>
            <option value="inactive">Pasif</option>
            <option value="all">Tümü</option>
          </select>
        </div>
        <button type="submit" className="btn-ghost">
          Filtrele
        </button>
      </form>

      {searchError ? (
        <p role="alert" className="mb-4 text-sm text-red-700 dark:text-red-400">
          {searchError}
        </p>
      ) : null}

      {result.items.length === 0 ? (
        <EmptyState title={sp.q ? "Aramayla eşleşen hasta yok" : "Henüz hasta yok"}>
          {hasPermission(ctx, "patient.create") ? (
            <Link href="/patients/new" className="font-medium text-brand-700">
              İlk hastayı kaydedin
            </Link>
          ) : null}
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Hasta No</th>
                <th scope="col">Hasta</th>
                <th scope="col">Telefon</th>
                <th scope="col">Ana şube</th>
                <th scope="col">KVKK</th>
                <th scope="col">Son güncelleme</th>
                <th scope="col">Durum</th>
                <th scope="col">
                  <span className="sr-only">İşlemler</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((p) => (
                <tr key={p.id}>
                  <td className="font-mono text-xs">{p.patientNumber}</td>
                  <td className="font-medium">
                    <Link href={`/patients/${p.id}`} className="hover:text-brand-700">
                      {p.firstName} {p.lastName}
                    </Link>
                  </td>
                  <td className="font-mono text-xs">{p.phoneMasked}</td>
                  <td>{p.primaryBranchName ?? "—"}</td>
                  <td>
                    <PrivacyBadge status={p.privacyStatus} />
                  </td>
                  <td className="whitespace-nowrap text-xs text-slate-500">{formatDateTime(p.updatedAt)}</td>
                  <td>
                    <StatusBadge active={p.active} />
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <div className="flex justify-end gap-2">
                      <Link href={`/patients/${p.id}`} className="btn-ghost btn-sm">
                        Görüntüle
                      </Link>
                      {hasPermission(ctx, "patient.update") ? (
                        <Link href={`/patients/${p.id}/edit`} className="btn-ghost btn-sm">
                          Düzenle
                        </Link>
                      ) : null}
                      {hasPermission(ctx, "patient.document.read") ? (
                        <Link href={`/patients/${p.id}?tab=documents`} className="btn-ghost btn-sm">
                          Belgeler
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 ? (
        <nav aria-label="Sayfalama" className="mt-4 flex items-center justify-between text-sm">
          <span className="text-slate-500">
            Sayfa {result.page} / {pages}
          </span>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Link href={qs(result.page - 1)} className="btn-ghost btn-sm">
                ← Önceki
              </Link>
            ) : null}
            {result.page < pages ? (
              <Link href={qs(result.page + 1)} className="btn-ghost btn-sm">
                Sonraki →
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </section>
  );
}
