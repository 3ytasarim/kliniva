import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { getInventoryDashboard, listCategories, listLocations } from "@/server/services/inventory";
import { accessibleBranchOptions } from "@/server/services/org";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader } from "@/components/ui";
import { InventoryNav, LOCATION_TYPE_LABELS, UNIT_LABELS } from "@/components/inventory-ui";
import { formatQuantity } from "@/lib/quantity";

export const metadata: Metadata = { title: "Stok" };

type Search = { branch?: string; location?: string; category?: string };

/** Stok paneli — kapsam içi sayılar ve kritik stok listesi. */
export default async function InventoryPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "inventory.read")) return <Forbidden />;
  const sp = await searchParams;
  const branches = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];
  const locations = await listLocations(ctx, { activeOnly: true });
  const categories = await listCategories(ctx);
  const filter = {
    branchId: branches.some((b) => b.id === sp.branch) ? sp.branch : undefined,
    locationId: locations.some((l) => l.id === sp.location) ? sp.location : undefined,
    categoryId: categories.some((c) => c.id === sp.category) ? sp.category : undefined,
  };
  const d = await getInventoryDashboard(ctx, filter);
  const canLow = hasPermission(ctx, "inventory.low_stock.read");

  const cards = [
    ["Toplam aktif ürün", d.activeItems],
    ["Düşük stok", canLow ? d.lowStock : "—"],
    ["Stoğu tükenen", canLow ? d.outOfStock : "—"],
    ["Bugünkü tüketim", d.todayUsage],
    ["Bugünkü transfer", d.todayTransfers],
  ] as const;

  return (
    <section>
      <PageHeader
        title="Stok"
        description="Klinik, şube ve oda stokları; hasta bazlı sarf tüketimi."
        actions={
          hasPermission(ctx, "inventory.item.create") ? (
            <Link href="/inventory/items#yeni-urun" className="btn">
              + Yeni ürün
            </Link>
          ) : null
        }
      />
      <InventoryNav current="/inventory" />

      <form className="card mb-6 grid gap-3 sm:grid-cols-2 sm:items-end xl:grid-cols-[repeat(3,minmax(0,1fr))_auto]">
        <div>
          <label htmlFor="i-branch" className="label">
            Şube
          </label>
          <select id="i-branch" name="branch" defaultValue={filter.branchId ?? ""} className="input">
            <option value="">Tüm şubeler</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="i-location" className="label">
            Lokasyon
          </label>
          <select id="i-location" name="location" defaultValue={filter.locationId ?? ""} className="input">
            <option value="">Tüm lokasyonlar</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.branchName} · {l.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="i-category" className="label">
            Kategori
          </label>
          <select id="i-category" name="category" defaultValue={filter.categoryId ?? ""} className="input">
            <option value="">Tüm kategoriler</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn-ghost">
          Filtrele
        </button>
      </form>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {cards.map(([title, value]) => (
          <div key={title} className="card">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</p>
            <p className="mt-2 text-3xl font-bold tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      {d.lotCards ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-3" aria-label="Lot ve SKT özeti">
          <Link href="/inventory/expiry" className="card hover:border-brand-300">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              SKT&apos;si yaklaşan lot
            </p>
            <p className="mt-2 text-3xl font-bold tabular-nums">{d.lotCards.expiringSoon}</p>
          </Link>
          <Link href="/inventory/expiry?tab=expired" className="card hover:border-brand-300">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              SKT&apos;si geçmiş lot
            </p>
            <p
              className={`mt-2 text-3xl font-bold tabular-nums ${d.lotCards.expired ? "text-red-700 dark:text-red-400" : ""}`}
            >
              {d.lotCards.expired}
            </p>
          </Link>
          <Link href="/inventory/items" className="card hover:border-brand-300">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Lot takipli ürün</p>
            <p className="mt-2 text-3xl font-bold tabular-nums">{d.lotCards.lotTrackedItems}</p>
          </Link>
        </div>
      ) : null}

      {canLow ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="card overflow-x-auto p-0">
            <h2 className="px-5 pt-5 font-semibold">Kritik stok (lokasyon bazında)</h2>
            {d.low.length === 0 ? (
              <p className="px-5 pb-5 pt-2 text-sm text-slate-500">Asgari seviyenin altında ürün yok.</p>
            ) : (
              <table className="table mt-3">
                <thead>
                  <tr>
                    <th scope="col">Ürün</th>
                    <th scope="col">Lokasyon</th>
                    <th scope="col">Kullanılabilir</th>
                    <th scope="col">Asgari</th>
                  </tr>
                </thead>
                <tbody>
                  {d.low.map((r) => (
                    <tr key={`${r.itemId}-${r.locationId}`}>
                      <td>
                        <Link
                          href={`/inventory/items/${r.itemId}`}
                          className="font-medium hover:text-brand-700"
                        >
                          {r.itemName}
                        </Link>
                      </td>
                      <td>
                        {r.branchName} · {r.locationName}{" "}
                        <span className="text-xs text-slate-500">
                          ({LOCATION_TYPE_LABELS[r.locationType]})
                        </span>
                      </td>
                      <td className="tabular-nums">
                        <span
                          className={`badge ${Number(r.usableQuantity) === 0 ? "badge-red" : "badge-amber"}`}
                        >
                          {formatQuantity(r.usableQuantity)} {UNIT_LABELS[r.unit]}
                        </span>
                        {r.trackLots && r.usableQuantity !== r.quantity ? (
                          <span className="ml-2 text-xs text-slate-500">
                            (fiziksel {formatQuantity(r.quantity)})
                          </span>
                        ) : null}
                      </td>
                      <td className="tabular-nums">{formatQuantity(r.minimumStockLevel)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card">
            <h2 className="mb-3 font-semibold">Stoğu tükenen ürünler</h2>
            {d.outOfStockItems.length === 0 ? (
              <EmptyState title="Tükenen ürün yok" />
            ) : (
              <ul className="grid gap-2 text-sm">
                {d.outOfStockItems.map((i) => (
                  <li key={i.id}>
                    <Link href={`/inventory/items/${i.id}`} className="font-medium hover:text-brand-700">
                      {i.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
