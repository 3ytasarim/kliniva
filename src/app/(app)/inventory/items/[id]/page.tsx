import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import {
  getInventoryItem,
  listCategories,
  listLocations,
  listStockMovements,
} from "@/server/services/inventory";
import {
  addStockAction,
  adjustStockAction,
  transferStockAction,
  updateItemAction,
} from "@/app/actions/inventory";
import { ActionForm, Field, SelectField } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { InventoryNav, LOCATION_TYPE_LABELS, MOVEMENT_LABELS, UNIT_LABELS } from "@/components/inventory-ui";
import { formatDateTime } from "@/components/patient-ui";
import { formatQuantity } from "@/lib/quantity";

export const metadata: Metadata = { title: "Stok ürünü" };

type Search = { page?: string; type?: string; location?: string; from?: string; to?: string };
const UNIT_OPTIONS = Object.entries(UNIT_LABELS).map(([value, label]) => ({ value, label }));
const TYPE_OPTIONS = Object.entries(MOVEMENT_LABELS).map(([value, label]) => ({ value, label }));

export default async function InventoryItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "inventory.read")) return <Forbidden />;
  const { id } = await params;
  const sp = await searchParams;
  let item: Awaited<ReturnType<typeof getInventoryItem>>;
  try {
    item = await getInventoryItem(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const locations = await listLocations(ctx, { activeOnly: true });
  const categories = await listCategories(ctx);
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);
  const moves = await listStockMovements(ctx, {
    inventoryItemId: item.id,
    movementType: sp.type && sp.type in MOVEMENT_LABELS ? sp.type : undefined,
    locationId: locations.some((l) => l.id === sp.location) ? sp.location : undefined,
    from: sp.from,
    to: sp.to,
    page,
  });
  const pages = Math.max(Math.ceil(moves.total / moves.limit), 1);
  const qs = (p: number) => {
    const u = new URLSearchParams();
    for (const k of ["type", "location", "from", "to"] as const) if (sp[k]) u.set(k, sp[k]!);
    u.set("page", String(p));
    return `/inventory/items/${item.id}?${u.toString()}#hareketler`;
  };
  const locOptions = locations.map((l) => ({ value: l.id, label: `${l.branchName} · ${l.name}` }));
  const unit = UNIT_LABELS[item.unit];
  const stockable = item.active && item.trackInventory && !item.trackLots;

  return (
    <section>
      <PageHeader
        title={item.name}
        description={`${item.code ? `${item.code} · ` : ""}${item.categoryName ?? "Kategorisiz"} · ${unit}`}
        back={{ href: "/inventory/items", label: "Ürünler" }}
        actions={
          <>
            {item.trackInventory ? (
              <span
                className={`badge ${Number(item.totalStock) === 0 ? "badge-red" : item.lowStock ? "badge-amber" : "badge-green"}`}
              >
                Toplam {formatQuantity(item.totalStock)} {unit}
                {item.lowStock ? " · düşük stok" : ""}
              </span>
            ) : null}
            <StatusBadge active={item.active} />
          </>
        }
      />
      <InventoryNav current="/inventory/items" />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid content-start gap-6">
          <div className="card overflow-x-auto p-0">
            <h2 className="px-5 pt-5 font-semibold">Lokasyon bazında stok</h2>
            {item.stockByLocation.length === 0 ? (
              <p className="px-5 pb-5 pt-2 text-sm text-slate-500">Bu ürün için henüz stok girişi yok.</p>
            ) : (
              <table className="table mt-3">
                <thead>
                  <tr>
                    <th scope="col">Lokasyon</th>
                    <th scope="col">Şube</th>
                    <th scope="col">Tip</th>
                    <th scope="col">Miktar</th>
                  </tr>
                </thead>
                <tbody>
                  {item.stockByLocation.map((r) => (
                    <tr key={r.locationId}>
                      <td className="font-medium">{r.locationName}</td>
                      <td>{r.branchName}</td>
                      <td>{LOCATION_TYPE_LABELS[r.locationType]}</td>
                      <td className="tabular-nums">
                        {formatQuantity(r.quantity)} {unit}
                        {item.minimumStockLevel !== null &&
                        Number(r.quantity) <= Number(item.minimumStockLevel) ? (
                          <span className="badge badge-amber ml-2">Düşük</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card overflow-x-auto p-0" id="hareketler">
            <h2 className="px-5 pt-5 font-semibold">Hareket geçmişi</h2>
            <form className="grid gap-3 px-5 pt-3 sm:grid-cols-2 sm:items-end xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
              <SelectField
                label="Tip"
                name="type"
                options={TYPE_OPTIONS}
                defaultValue={sp.type ?? ""}
                placeholder="Tümü"
                idPrefix="mv"
              />
              <SelectField
                label="Lokasyon"
                name="location"
                options={locOptions}
                defaultValue={sp.location ?? ""}
                placeholder="Tümü"
                idPrefix="mv"
              />
              <Field label="Başlangıç" name="from" type="date" defaultValue={sp.from ?? ""} idPrefix="mv" />
              <Field label="Bitiş" name="to" type="date" defaultValue={sp.to ?? ""} idPrefix="mv" />
              <button type="submit" className="btn-ghost">
                Filtrele
              </button>
            </form>
            {moves.items.length === 0 ? (
              <p className="px-5 pb-5 pt-3 text-sm text-slate-500">Hareket yok.</p>
            ) : (
              <table className="table mt-3">
                <thead>
                  <tr>
                    <th scope="col">Tarih</th>
                    <th scope="col">Tip</th>
                    <th scope="col">Kaynak</th>
                    <th scope="col">Hedef</th>
                    <th scope="col">Miktar</th>
                    <th scope="col">Kullanıcı</th>
                    <th scope="col">Referans</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.items.map((m) => (
                    <tr key={m.id}>
                      <td className="whitespace-nowrap text-xs">{formatDateTime(m.createdAt)}</td>
                      <td>
                        <span className="badge badge-gray">{MOVEMENT_LABELS[m.movementType]}</span>
                      </td>
                      <td>{m.fromLocationName ?? "—"}</td>
                      <td>{m.toLocationName ?? "—"}</td>
                      <td className="tabular-nums">
                        {m.fromLocationName && !m.toLocationName
                          ? "−"
                          : m.toLocationName && !m.fromLocationName
                            ? "+"
                            : ""}
                        {formatQuantity(m.quantity)}
                      </td>
                      <td>{m.userName ?? "—"}</td>
                      <td className="text-xs">
                        {m.patientUsageId ? (
                          <Link
                            href={`/inventory/usages/${m.patientUsageId}`}
                            className="text-brand-700 hover:underline"
                          >
                            Hasta kullanımı
                          </Link>
                        ) : (
                          (m.reference ?? m.reason ?? "—")
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {pages > 1 ? (
              <nav
                aria-label="Hareket sayfalama"
                className="flex items-center justify-between px-5 py-3 text-sm"
              >
                <span className="text-slate-500">
                  Sayfa {moves.page} / {pages} · {moves.total} hareket
                </span>
                <div className="flex gap-2">
                  {moves.page > 1 ? (
                    <Link href={qs(moves.page - 1)} className="btn-ghost btn-sm">
                      ← Önceki
                    </Link>
                  ) : null}
                  {moves.page < pages ? (
                    <Link href={qs(moves.page + 1)} className="btn-ghost btn-sm">
                      Sonraki →
                    </Link>
                  ) : null}
                </div>
              </nav>
            ) : null}
          </div>
        </div>

        <div className="grid content-start gap-4">
          {!stockable ? (
            <p className="card text-sm text-slate-600 dark:text-slate-400">
              {item.trackLots
                ? "Lot takipli ürünlerin hareketleri sonraki sürümde desteklenecek."
                : "Ürün pasif veya stok takibi kapalı; stok hareketi yapılamaz."}
            </p>
          ) : null}
          {stockable && hasPermission(ctx, "inventory.stock.add") ? (
            <div className="card">
              <h2 className="font-semibold">Stok girişi</h2>
              <ActionForm action={addStockAction} submitLabel="Stok ekle" className="mt-4 grid gap-3">
                <input type="hidden" name="inventoryItemId" value={item.id} />
                <SelectField label="Lokasyon" name="locationId" options={locOptions} required idPrefix="as" />
                <SelectField
                  label="Giriş tipi"
                  name="kind"
                  options={[
                    { value: "INITIAL_STOCK", label: "İlk stok" },
                    { value: "PURCHASE", label: "Alım / giriş" },
                  ]}
                  defaultValue={item.stockByLocation.length ? "PURCHASE" : "INITIAL_STOCK"}
                  idPrefix="as"
                />
                <Field
                  label={`Miktar (${unit})`}
                  name="quantity"
                  inputMode="decimal"
                  required
                  idPrefix="as"
                />
                <Field label="Referans (irsaliye vb.)" name="reference" idPrefix="as" maxLength={80} />
              </ActionForm>
            </div>
          ) : null}
          {stockable && hasPermission(ctx, "inventory.transfer") && item.stockByLocation.length ? (
            <details className="card">
              <summary className="cursor-pointer font-semibold">Transfer</summary>
              <ActionForm action={transferStockAction} submitLabel="Transfer et" className="mt-4 grid gap-3">
                <input type="hidden" name="inventoryItemId" value={item.id} />
                <SelectField
                  label="Kaynak"
                  name="fromLocationId"
                  options={item.stockByLocation
                    .filter((r) => Number(r.quantity) > 0)
                    .map((r) => ({
                      value: r.locationId,
                      label: `${r.branchName} · ${r.locationName} (${formatQuantity(r.quantity)})`,
                    }))}
                  required
                  idPrefix="tr"
                />
                <SelectField label="Hedef" name="toLocationId" options={locOptions} required idPrefix="tr" />
                <Field
                  label={`Miktar (${unit})`}
                  name="quantity"
                  inputMode="decimal"
                  required
                  idPrefix="tr"
                />
                <Field label="Açıklama" name="reason" idPrefix="tr" maxLength={300} />
              </ActionForm>
            </details>
          ) : null}
          {stockable && hasPermission(ctx, "inventory.stock.adjust") && item.stockByLocation.length ? (
            <details className="card">
              <summary className="cursor-pointer font-semibold">Düzeltme / fire</summary>
              <ActionForm
                action={adjustStockAction}
                submitLabel="Düzeltmeyi kaydet"
                className="mt-4 grid gap-3"
              >
                <input type="hidden" name="inventoryItemId" value={item.id} />
                <SelectField label="Lokasyon" name="locationId" options={locOptions} required idPrefix="ad" />
                <SelectField
                  label="Yön"
                  name="direction"
                  options={[
                    { value: "IN", label: "Artır (+)" },
                    { value: "OUT", label: "Azalt (−)" },
                  ]}
                  idPrefix="ad"
                />
                <SelectField
                  label="Tür"
                  name="kind"
                  options={[
                    { value: "ADJUSTMENT", label: "Sayım düzeltmesi" },
                    { value: "WRITE_OFF", label: "Fire / imha (yalnızca azaltma)" },
                  ]}
                  idPrefix="ad"
                />
                <Field
                  label={`Miktar (${unit})`}
                  name="quantity"
                  inputMode="decimal"
                  required
                  idPrefix="ad"
                />
                <Field label="Gerekçe" name="reason" required minLength={3} maxLength={300} idPrefix="ad" />
                <p className="hint">Hareketler silinmez; hatalı kayıt ters hareketle düzeltilir.</p>
              </ActionForm>
            </details>
          ) : null}
          {hasPermission(ctx, "inventory.item.update") ? (
            <details className="card">
              <summary className="cursor-pointer font-semibold">Ürünü düzenle</summary>
              <ActionForm action={updateItemAction} submitLabel="Kaydet" className="mt-4 grid gap-3">
                <input type="hidden" name="id" value={item.id} />
                <Field label="Ürün adı" name="name" required defaultValue={item.name} idPrefix="ed" />
                <Field label="Kod" name="code" defaultValue={item.code ?? ""} idPrefix="ed" />
                <Field label="Barkod" name="barcode" defaultValue={item.barcode ?? ""} idPrefix="ed" />
                <SelectField
                  label="Kategori"
                  name="categoryId"
                  options={categories.map((c) => ({ value: c.id, label: c.name }))}
                  defaultValue={item.categoryId ?? ""}
                  placeholder="Kategorisiz"
                  idPrefix="ed"
                />
                <SelectField
                  label="Birim"
                  name="unit"
                  options={UNIT_OPTIONS}
                  defaultValue={item.unit}
                  idPrefix="ed"
                />
                <Field
                  label="Asgari stok"
                  name="minimumStockLevel"
                  inputMode="decimal"
                  defaultValue={
                    item.minimumStockLevel ? formatQuantity(item.minimumStockLevel).replace(",", ".") : ""
                  }
                  idPrefix="ed"
                />
                <input type="hidden" name="trackInventory" value={item.trackInventory ? "true" : "false"} />
                <label className="flex min-h-10 items-center gap-2 text-sm">
                  <input type="checkbox" name="active" defaultChecked={item.active} />
                  Aktif (pasif ürün yeni harekete kapanır; geçmiş korunur)
                </label>
              </ActionForm>
            </details>
          ) : null}
          {item.stockByLocation.length === 0 && !stockable ? <EmptyState title="Stok yok" /> : null}
        </div>
      </div>
    </section>
  );
}
