import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { listCategories, listLocations } from "@/server/services/inventory";
import { getExpiringLots } from "@/server/services/lots";
import { accessibleBranchOptions } from "@/server/services/org";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader } from "@/components/ui";
import { InventoryNav, LotStatusBadge, UNIT_LABELS, formatExpiry } from "@/components/inventory-ui";
import { formatQuantity } from "@/lib/quantity";

export const metadata: Metadata = { title: "SKT takibi" };

type Search = { tab?: string; branch?: string; location?: string; category?: string; days?: string };

/**
 * SKT takibi — "Yakında dolacak" (bugün … bugün + gün) ve "Süresi geçmiş" (fiziksel stok; imha / iade bekler).
 * "Bugün" her lot için kendi şubesinin saat dilimindedir; lot SKT gününün sonuna kadar kullanılabilir.
 */
export default async function ExpiryPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "inventory.expiry.read")) return <Forbidden />;
  const sp = await searchParams;
  const kind = sp.tab === "expired" ? "expired" : "expiring";
  const branches = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];
  const locations = await listLocations(ctx, { activeOnly: true });
  const categories = await listCategories(ctx);
  const daysNum = Number(sp.days);
  const filter = {
    branchId: branches.some((b) => b.id === sp.branch) ? sp.branch : undefined,
    locationId: locations.some((l) => l.id === sp.location) ? sp.location : undefined,
    categoryId: categories.some((c) => c.id === sp.category) ? sp.category : undefined,
    days: Number.isInteger(daysNum) && daysNum >= 1 && daysNum <= 365 ? daysNum : undefined,
  };
  const report = await getExpiringLots(ctx, { ...filter, kind });
  const tabHref = (t: "expiring" | "expired") => {
    const u = new URLSearchParams();
    if (t === "expired") u.set("tab", "expired");
    if (filter.branchId) u.set("branch", filter.branchId);
    if (filter.locationId) u.set("location", filter.locationId);
    if (filter.categoryId) u.set("category", filter.categoryId);
    if (filter.days) u.set("days", String(filter.days));
    const q = u.toString();
    return `/inventory/expiry${q ? `?${q}` : ""}`;
  };

  return (
    <section>
      <PageHeader
        title="SKT takibi"
        description="Son kullanma tarihi yaklaşan ve geçmiş lotlar. Süresi geçmiş lot hasta kullanımına kapalıdır; fiziksel stok olarak imha / iade edilene kadar görünür."
      />
      <InventoryNav current="/inventory/expiry" />

      <form className="card mb-4 grid gap-3 sm:grid-cols-2 sm:items-end xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
        {kind === "expired" ? <input type="hidden" name="tab" value="expired" /> : null}
        <div>
          <label htmlFor="x-branch" className="label">
            Şube
          </label>
          <select id="x-branch" name="branch" defaultValue={filter.branchId ?? ""} className="input">
            <option value="">Tüm şubeler</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="x-location" className="label">
            Lokasyon
          </label>
          <select id="x-location" name="location" defaultValue={filter.locationId ?? ""} className="input">
            <option value="">Tüm lokasyonlar</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.branchName} · {l.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="x-category" className="label">
            Kategori
          </label>
          <select id="x-category" name="category" defaultValue={filter.categoryId ?? ""} className="input">
            <option value="">Tüm kategoriler</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="x-days" className="label">
            Gün penceresi
          </label>
          <input
            id="x-days"
            name="days"
            type="number"
            min={1}
            max={365}
            inputMode="numeric"
            defaultValue={filter.days ?? report.days}
            className="input"
            aria-describedby="x-days-hint"
          />
          <p id="x-days-hint" className="hint">
            Boşsa klinik ayarı ({report.days} gün).
          </p>
        </div>
        <button type="submit" className="btn-ghost">
          Filtrele
        </button>
      </form>

      <nav aria-label="SKT sekmeleri" className="mb-4 flex gap-2">
        <Link
          href={tabHref("expiring")}
          aria-current={kind === "expiring" ? "page" : undefined}
          className={kind === "expiring" ? "btn btn-sm" : "btn-ghost btn-sm"}
        >
          Yakında dolacak
        </Link>
        <Link
          href={tabHref("expired")}
          aria-current={kind === "expired" ? "page" : undefined}
          className={kind === "expired" ? "btn btn-sm" : "btn-ghost btn-sm"}
        >
          Süresi geçmiş
        </Link>
      </nav>

      {report.rows.length === 0 ? (
        <EmptyState
          title={
            kind === "expired"
              ? "Süresi geçmiş stok yok"
              : `Önümüzdeki ${report.days} günde SKT'si dolan lot yok`
          }
        />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <caption className="sr-only">
              {kind === "expired" ? "Süresi geçmiş lotlar" : "SKT'si yaklaşan lotlar"}
            </caption>
            <thead>
              <tr>
                <th scope="col">Ürün</th>
                <th scope="col">Lot</th>
                <th scope="col">Lokasyon</th>
                <th scope="col">Miktar</th>
                <th scope="col">SKT</th>
                <th scope="col">Kalan gün</th>
                <th scope="col">Durum</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link
                      href={`/inventory/items/${r.inventoryItemId}`}
                      className="font-medium hover:text-brand-700"
                    >
                      {r.itemName}
                    </Link>
                  </td>
                  <td className="font-mono text-xs">
                    <Link href={`/inventory/lots/${r.id}`} className="text-brand-700 hover:underline">
                      {r.lotNumber}
                    </Link>
                  </td>
                  <td>
                    {r.branchName} · {r.locationName}
                  </td>
                  <td className="tabular-nums">
                    {formatQuantity(r.quantity)} {UNIT_LABELS[r.unit]}
                  </td>
                  <td className="whitespace-nowrap">{formatExpiry(r.expiryDate)}</td>
                  <td className="tabular-nums">
                    {r.daysRemaining === null
                      ? "—"
                      : r.daysRemaining < 0
                        ? `${-r.daysRemaining} gün geçti`
                        : r.daysRemaining === 0
                          ? "Bugün son gün"
                          : r.daysRemaining}
                  </td>
                  <td>
                    <LotStatusBadge status={r.status} />
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
