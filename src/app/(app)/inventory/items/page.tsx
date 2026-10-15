import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { listCategories, listInventoryItems } from "@/server/services/inventory";
import { createCategoryAction, createItemAction } from "@/app/actions/inventory";
import { ActionForm, Field, SelectField } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { InventoryNav, UNIT_LABELS } from "@/components/inventory-ui";
import { formatQuantity } from "@/lib/quantity";

export const metadata: Metadata = { title: "Stok ürünleri" };

type Search = { q?: string; category?: string; status?: string; page?: string };

const UNIT_OPTIONS = Object.entries(UNIT_LABELS).map(([value, label]) => ({ value, label }));

export default async function InventoryItemsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "inventory.read")) return <Forbidden />;
  const sp = await searchParams;
  const status = sp.status === "inactive" || sp.status === "all" ? sp.status : "active";
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);
  const categories = await listCategories(ctx);
  const result = await listInventoryItems(ctx, {
    q: sp.q,
    categoryId: categories.some((c) => c.id === sp.category) ? sp.category : undefined,
    status,
    page,
  });
  const pages = Math.max(Math.ceil(result.total / result.limit), 1);
  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (sp.q) u.set("q", sp.q);
    if (sp.category) u.set("category", sp.category);
    if (status !== "active") u.set("status", status);
    u.set("page", String(p));
    return `/inventory/items?${u.toString()}`;
  };
  const canCreate = hasPermission(ctx, "inventory.item.create");

  return (
    <section>
      <PageHeader title="Stok ürünleri" description={`${result.total} ürün`} />
      <InventoryNav current="/inventory/items" />

      <form
        role="search"
        className="card mb-6 grid gap-3 sm:grid-cols-2 sm:items-end xl:grid-cols-[minmax(0,1fr)_200px_160px_auto]"
      >
        <div>
          <label htmlFor="it-q" className="label">
            Ara
          </label>
          <input
            id="it-q"
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Ad, kod veya barkod"
            className="input"
            maxLength={100}
          />
        </div>
        <div>
          <label htmlFor="it-cat" className="label">
            Kategori
          </label>
          <select id="it-cat" name="category" defaultValue={sp.category ?? ""} className="input">
            <option value="">Tümü</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="it-status" className="label">
            Durum
          </label>
          <select id="it-status" name="status" defaultValue={status} className="input">
            <option value="active">Aktif</option>
            <option value="inactive">Pasif</option>
            <option value="all">Tümü</option>
          </select>
        </div>
        <button type="submit" className="btn-ghost">
          Filtrele
        </button>
      </form>

      {result.items.length === 0 ? (
        <EmptyState title={sp.q ? "Aramayla eşleşen ürün yok" : "Henüz ürün yok"} />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Kod</th>
                <th scope="col">Ürün</th>
                <th scope="col">Kategori</th>
                <th scope="col">Birim</th>
                <th scope="col">Toplam stok</th>
                <th scope="col">Stok durumu</th>
                <th scope="col">Durum</th>
                <th scope="col">
                  <span className="sr-only">İşlemler</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((i) => (
                <tr key={i.id}>
                  <td className="font-mono text-xs">{i.code ?? "—"}</td>
                  <td className="font-medium">
                    <Link href={`/inventory/items/${i.id}`} className="hover:text-brand-700">
                      {i.name}
                    </Link>
                  </td>
                  <td>{i.categoryName ?? "—"}</td>
                  <td>{UNIT_LABELS[i.unit]}</td>
                  <td className="tabular-nums">
                    {i.trackInventory ? formatQuantity(i.totalStock) : "Takip yok"}
                  </td>
                  <td>
                    {!i.trackInventory ? (
                      "—"
                    ) : Number(i.totalStock) === 0 ? (
                      <span className="badge badge-red">Tükendi</span>
                    ) : i.lowStock ? (
                      <span className="badge badge-amber">Düşük</span>
                    ) : (
                      <span className="badge badge-green">Yeterli</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge active={i.active} />
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <Link href={`/inventory/items/${i.id}`} className="btn-ghost btn-sm">
                      Görüntüle
                    </Link>
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

      {canCreate ? (
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="card" id="yeni-urun">
            <h2 className="mb-1 font-semibold">Yeni ürün</h2>
            <p className="hint mb-4">Ürün stoksuz oluşturulur; ilk stok ürün sayfasından ayrıca girilir.</p>
            <ActionForm
              action={createItemAction}
              submitLabel="Ürünü oluştur"
              className="grid gap-4 sm:grid-cols-2"
            >
              <Field label="Ürün adı" name="name" required idPrefix="ni" />
              <Field label="Kod" name="code" idPrefix="ni" maxLength={40} />
              <Field label="Barkod" name="barcode" idPrefix="ni" maxLength={64} />
              <SelectField
                label="Kategori"
                name="categoryId"
                options={categories.filter((c) => c.active).map((c) => ({ value: c.id, label: c.name }))}
                placeholder="Kategorisiz"
                idPrefix="ni"
              />
              <SelectField
                label="Birim"
                name="unit"
                options={UNIT_OPTIONS}
                defaultValue="PIECE"
                idPrefix="ni"
              />
              <Field
                label="Asgari stok seviyesi"
                name="minimumStockLevel"
                inputMode="decimal"
                idPrefix="ni"
                hint="Bu seviyeye inen lokasyonlar kritik stokta görünür."
              />
              <Field label="Açıklama" name="description" idPrefix="ni" className="sm:col-span-2" />
            </ActionForm>
          </div>
          <div className="card">
            <h2 className="mb-4 font-semibold">Yeni kategori</h2>
            <ActionForm action={createCategoryAction} submitLabel="Kategori ekle" className="grid gap-4">
              <Field label="Kategori adı" name="name" required idPrefix="nc" />
              <Field label="Açıklama" name="description" idPrefix="nc" />
            </ActionForm>
            {categories.length ? (
              <ul className="mt-4 flex flex-wrap gap-2">
                {categories.map((c) => (
                  <li key={c.id} className="badge badge-gray">
                    {c.name}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
