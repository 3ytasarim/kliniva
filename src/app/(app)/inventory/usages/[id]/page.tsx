import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { getPatientMaterialUsage } from "@/server/services/material-usage";
import { listInventoryItems, listLocations } from "@/server/services/inventory";
import {
  addUsageItemAction,
  finalizeUsageAction,
  removeUsageItemAction,
  setUsageLotsAction,
  voidUsageAction,
} from "@/app/actions/inventory";
import { ActionForm, Field, InlineAction, SelectField } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui";
import { UNIT_LABELS, UsageStatusBadge, formatExpiry } from "@/components/inventory-ui";
import { formatDateTime } from "@/components/patient-ui";
import { formatQuantity } from "@/lib/quantity";

export const metadata: Metadata = { title: "Malzeme kullanımı" };

/**
 * Hasta malzeme kullanımı. Taslak stok düşürmez; "Kesinleştir" tüm kalemleri tek işlemde düşer (biri yetersizse
 * hiçbiri). Kesinleşen kayıt değişmez; hata VOID (ters hareket) ile düzeltilir.
 */
export default async function UsagePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "inventory.usage.read")) return <Forbidden />;
  const { id } = await params;
  let u: Awaited<ReturnType<typeof getPatientMaterialUsage>>;
  try {
    u = await getPatientMaterialUsage(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const draft = u.status === "DRAFT";
  const canEdit = draft && hasPermission(ctx, "inventory.usage.create");
  const locations = canEdit ? await listLocations(ctx, { branchId: u.branchId, activeOnly: true }) : [];
  const items = canEdit
    ? (await listInventoryItems(ctx, { limit: 100 })).items.filter((i) => i.trackInventory)
    : [];
  const short = u.lines.filter((l) => Number(l.available) < Number(l.quantity));
  const canLots = hasPermission(ctx, "inventory.lot.read");
  const cols = 3 + (draft ? 1 : 0) + (canEdit ? 1 : 0);
  const lotText = (xs: { lotNumber: string; expiryDate: string | null; quantity: string }[]) =>
    xs
      .map(
        (a) =>
          `${a.lotNumber}${a.expiryDate ? ` (SKT ${formatExpiry(a.expiryDate)})` : ""} × ${formatQuantity(a.quantity)}`,
      )
      .join(", ");

  return (
    <section className="grid gap-6">
      <PageHeader
        title="Malzeme kullanımı"
        description={`${u.patient.name} · ${u.patient.patientNumber}${u.appointmentStart ? ` · randevu ${formatDateTime(u.appointmentStart)}` : ""}`}
        back={
          u.appointmentId
            ? { href: `/appointments/${u.appointmentId}`, label: "Randevu" }
            : { href: `/patients/${u.patient.id}?tab=materials`, label: "Hasta dosyası" }
        }
        actions={<UsageStatusBadge status={u.status} />}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid content-start gap-6">
          <div className="card overflow-x-auto p-0">
            <h2 className="px-5 pt-5 font-semibold">Kullanılan malzemeler</h2>
            {draft ? (
              <p className="hint px-5">
                Taslak: stok henüz düşmedi. Önerilen miktarları gerçek kullanıma göre düzenleyin.
              </p>
            ) : null}
            {u.lines.length === 0 ? (
              <p className="px-5 pb-5 pt-2 text-sm text-slate-500">Henüz malzeme eklenmedi.</p>
            ) : (
              <table className="table mt-3">
                <thead>
                  <tr>
                    <th scope="col">Malzeme</th>
                    <th scope="col">Stok kaynağı</th>
                    <th scope="col">Miktar</th>
                    {draft ? <th scope="col">Mevcut</th> : null}
                    {canEdit ? (
                      <th scope="col">
                        <span className="sr-only">İşlem</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {u.lines.map((l) => (
                    <Fragment key={l.id}>
                      <tr>
                        <td className="font-medium">{l.itemName}</td>
                        <td>{l.locationName}</td>
                        <td>
                          {canEdit ? (
                            <ActionForm
                              action={addUsageItemAction}
                              submitLabel="Güncelle"
                              className="flex flex-wrap items-center gap-2"
                            >
                              <input type="hidden" name="usageId" value={u.id} />
                              <input type="hidden" name="inventoryItemId" value={l.inventoryItemId} />
                              <input type="hidden" name="locationId" value={l.locationId} />
                              <label htmlFor={`q-${l.id}`} className="sr-only">
                                {l.itemName} miktarı
                              </label>
                              <input
                                id={`q-${l.id}`}
                                name="quantity"
                                inputMode="decimal"
                                defaultValue={formatQuantity(l.quantity).replace(",", ".")}
                                className="input w-24"
                              />
                            </ActionForm>
                          ) : (
                            <span className="tabular-nums">
                              {formatQuantity(l.quantity)} {UNIT_LABELS[l.unit]}
                            </span>
                          )}
                        </td>
                        {draft ? (
                          <td className="tabular-nums">
                            <span
                              className={`badge ${Number(l.available) < Number(l.quantity) ? "badge-red" : "badge-gray"}`}
                            >
                              {formatQuantity(l.available)}
                            </span>
                          </td>
                        ) : null}
                        {canEdit ? (
                          <td className="text-right">
                            <InlineAction
                              action={removeUsageItemAction}
                              fields={{ usageId: u.id, rowId: l.id }}
                              label="Kaldır"
                              variant="danger"
                            />
                          </td>
                        ) : null}
                      </tr>
                      {l.trackLots && canLots ? (
                        <tr>
                          <td colSpan={cols} className="bg-slate-50 text-sm dark:bg-slate-900/40">
                            {l.allocations.length ? (
                              <p>
                                <span className="text-slate-500">
                                  {draft ? "Elle seçilen lot:" : "Kullanılan lot:"}
                                </span>{" "}
                                <span className="font-mono text-xs" data-testid="usage-lots">
                                  {lotText(l.allocations)}
                                </span>
                              </p>
                            ) : draft ? (
                              l.shortfall ? (
                                <p role="alert" className="text-red-700 dark:text-red-400">
                                  Kullanılabilir (SKT&apos;si geçmemiş, geri çağrılmamış) lot stoğu yetersiz.
                                </p>
                              ) : (
                                <p>
                                  <span className="text-slate-500">Önerilen lot (FEFO):</span>{" "}
                                  <span className="font-mono text-xs" data-testid="usage-lots-suggested">
                                    {lotText(l.suggested)}
                                  </span>
                                  <span className="hint block">
                                    Kesinleştirmede sunucu yeniden kontrol eder.
                                  </span>
                                </p>
                              )
                            ) : null}
                            {canEdit && l.lotOptions.length ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-sm font-medium text-brand-700">
                                  Lotu elle seç
                                </summary>
                                <ActionForm
                                  action={setUsageLotsAction}
                                  submitLabel="Lot seçimini kaydet"
                                  className="mt-2 grid gap-2 sm:grid-cols-2"
                                >
                                  <input type="hidden" name="usageId" value={u.id} />
                                  <input type="hidden" name="rowId" value={l.id} />
                                  {l.lotOptions.map((o) => (
                                    <Field
                                      key={o.stockLotId}
                                      label={`${o.lotNumber}${o.expiryDate ? ` · SKT ${formatExpiry(o.expiryDate)}` : ""} (mevcut ${formatQuantity(o.available)})`}
                                      name={`lot_${o.stockLotId}`}
                                      inputMode="decimal"
                                      idPrefix={`lot-${l.id}`}
                                    />
                                  ))}
                                  <p className="hint sm:col-span-2">
                                    Toplam kalem miktarına ({formatQuantity(l.quantity)}) eşit olmalı. Süresi
                                    geçmiş / geri çağrılmış lotlar listelenmez.
                                  </p>
                                </ActionForm>
                                {l.allocations.length ? (
                                  <div className="mt-2">
                                    <InlineAction
                                      action={setUsageLotsAction}
                                      fields={{ usageId: u.id, rowId: l.id, mode: "auto" }}
                                      label="Otomatik FEFO'ya dön"
                                    />
                                  </div>
                                ) : null}
                              </details>
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {canEdit ? (
            <div className="card">
              <h2 className="mb-4 font-semibold">Malzeme ekle</h2>
              <ActionForm
                action={addUsageItemAction}
                submitLabel="Ekle"
                className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_120px] sm:items-end"
              >
                <input type="hidden" name="usageId" value={u.id} />
                <SelectField
                  label="Malzeme"
                  name="inventoryItemId"
                  options={items.map((i) => ({
                    value: i.id,
                    label: `${i.name}${i.code ? ` (${i.code})` : ""}`,
                  }))}
                  required
                  idPrefix="ua"
                />
                <SelectField
                  label="Stok kaynağı"
                  name="locationId"
                  options={locations.map((l) => ({ value: l.id, label: l.name }))}
                  defaultValue={
                    locations.find((l) => l.roomId && l.roomId === u.roomId)?.id ?? locations[0]?.id
                  }
                  required
                  idPrefix="ua"
                />
                <Field
                  label="Miktar"
                  name="quantity"
                  inputMode="decimal"
                  required
                  defaultValue="1"
                  idPrefix="ua"
                />
              </ActionForm>
            </div>
          ) : null}
        </div>

        <aside className="grid content-start gap-4">
          <div className="card grid gap-2 text-sm">
            <p>
              <span className="text-slate-500">Şube:</span> {u.branchName}
            </p>
            <p>
              <span className="text-slate-500">Oda:</span> {u.roomName ?? "—"}
            </p>
            <p>
              <span className="text-slate-500">Doktor:</span> {u.doctorName ?? "—"}
            </p>
            {u.finalizedAt ? (
              <p>
                <span className="text-slate-500">Kesinleşme:</span> {formatDateTime(u.finalizedAt)}
              </p>
            ) : null}
            {u.status === "VOIDED" && u.voidReason ? (
              <p>
                <span className="text-slate-500">VOID gerekçesi:</span> {u.voidReason}
              </p>
            ) : null}
            {u.notes ? (
              <p className="whitespace-pre-line">
                <span className="text-slate-500">Not:</span> {u.notes}
              </p>
            ) : null}
          </div>
          {draft && hasPermission(ctx, "inventory.usage.finalize") && u.lines.length ? (
            <div className="card grid gap-3">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Kesinleştirince tüm malzemeler seçili lokasyonlardan düşülür. Bir malzemede bile stok
                yetersizse hiçbiri düşülmez.
              </p>
              {short.length ? (
                <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                  Yetersiz stok: {short.map((s) => s.itemName).join(", ")}
                </p>
              ) : null}
              <InlineAction
                action={finalizeUsageAction}
                fields={{ usageId: u.id }}
                label="Kesinleştir"
                variant="primary"
              />
            </div>
          ) : null}
          {u.status !== "VOIDED" && hasPermission(ctx, "inventory.usage.void") ? (
            <details className="card">
              <summary className="cursor-pointer text-sm font-medium text-red-700 dark:text-red-400">
                {u.status === "FINALIZED" ? "Geçersiz kıl (stok iade edilir)" : "Taslağı iptal et"}
              </summary>
              <ActionForm action={voidUsageAction} submitLabel="Geçersiz kıl" className="mt-3 grid gap-3">
                <input type="hidden" name="usageId" value={u.id} />
                <Field label="Gerekçe" name="reason" required minLength={3} maxLength={500} idPrefix="vd" />
              </ActionForm>
            </details>
          ) : null}
          {u.appointmentId ? (
            <Link href={`/appointments/${u.appointmentId}`} className="btn-ghost">
              Randevuya dön
            </Link>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
