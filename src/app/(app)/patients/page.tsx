import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { listPatients } from "@/server/services/patients";
import { listBranches } from "@/server/services/org";
import { ActionForm, Field } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { createPatientAction } from "@/app/actions/admin";

export const metadata: Metadata = { title: "Hastalar" };

/**
 * Hasta listesi — minimum gerekli veri: dosya no, ad soyad, maskeli telefon. Sağlık verisi listede asla yer almaz.
 * Tıbbi not alanı yalnızca patient.health.write yetkisi olan kullanıcıya gösterilir (sunucu da ayrıca doğrular).
 */
export default async function PatientsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "patient.read")) return <Forbidden />;
  const { q } = await searchParams;
  const [rows, branchList] = await Promise.all([
    listPatients(ctx, { q }),
    hasPermission(ctx, "branch.read") ? listBranches(ctx) : Promise.resolve([]),
  ]);
  const canWriteHealth = hasPermission(ctx, "patient.health.write");

  return (
    <section className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-bold">Hastalar</h1>
        <form role="search" className="flex gap-2">
          <label htmlFor="q" className="sr-only">
            Hasta ara
          </label>
          <input
            id="q"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Ad, soyad veya dosya no"
            className="input"
          />
          <button type="submit" className="btn-ghost">
            Ara
          </button>
        </form>
      </div>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Dosya No</th>
              <th scope="col">Ad Soyad</th>
              <th scope="col">Telefon</th>
              <th scope="col">Durum</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="font-mono text-xs">{p.patientNumber}</td>
                <td>
                  {p.firstName} {p.lastName}
                </td>
                <td className="font-mono text-xs">{p.phoneMasked}</td>
                <td>{p.active ? "Aktif" : "Pasif"}</td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={4} className="text-slate-500">
                  Kayıt bulunamadı.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {hasPermission(ctx, "patient.create") ? (
        <div className="card">
          <h2 className="mb-4 font-semibold">Yeni hasta</h2>
          <ActionForm
            action={createPatientAction}
            submitLabel="Hasta ekle"
            className="grid gap-4 sm:grid-cols-2"
          >
            <Field label="Ad" name="firstName" required autoComplete="off" />
            <Field label="Soyad" name="lastName" required autoComplete="off" />
            <Field label="Telefon" name="phone" type="tel" required autoComplete="off" />
            <Field label="E-posta" name="email" type="email" autoComplete="off" />
            <Field label="Doğum tarihi" name="birthDate" type="date" />
            <div>
              <label htmlFor="f-branchId" className="label">
                Şube
              </label>
              <select id="f-branchId" name="branchId" className="input">
                {ctx.branchScope.all ? <option value="">Şube seçilmedi</option> : null}
                {branchList.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            {canWriteHealth ? (
              <div className="sm:col-span-2">
                <label htmlFor="f-notes" className="label">
                  Tıbbi not (şifreli saklanır)
                </label>
                <textarea id="f-notes" name="notes" rows={3} className="input" />
              </div>
            ) : null}
          </ActionForm>
        </div>
      ) : null}
    </section>
  );
}
