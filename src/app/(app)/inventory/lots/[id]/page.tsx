import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { findPatientsByLot, getLot, lotCapabilities, type LotTraceRow } from "@/server/services/lots";
import { listStockMovements } from "@/server/services/inventory";
import { correctLotAction, recallLotAction, writeOffLotAction } from "@/app/actions/inventory";
import { ActionForm, Field } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui";
import {
  InventoryNav,
  LotStatusBadge,
  MOVEMENT_LABELS,
  UNIT_LABELS,
  UsageStatusBadge,
  formatExpiry,
} from "@/components/inventory-ui";
import { formatDateTime } from "@/components/patient-ui";
import { formatQuantity } from "@/lib/quantity";

export const metadata: Metadata = { title: "Lot" };

/**
 * Lot detayı: kimlik (numara değişmez), SKT, durum, aynı lotun diğer lokasyonları, hareketler; yetkiye göre SKT
 * düzeltme, imha, geri çağırma ve hasta izleme (yalnızca istek üzerine — her görüntüleme audit'lenir).
 */
export default async function LotPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ trace?: string }>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "inventory.lot.read")) return <Forbidden />;
  const { id } = await params;
  const sp = await searchParams;
  let lot: Awaited<ReturnType<typeof getLot>>;
  try {
    lot = await getLot(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const can = lotCapabilities(ctx, lot.branchId);
  const moves = await listStockMovements(ctx, { stockLotId: lot.id, limit: 50 });
  let trace: LotTraceRow[] | null = null;
  if (can.trace && sp.trace === "1") trace = (await findPatientsByLot(ctx, { stockLotId: lot.id })).rows;
  const unit = UNIT_LABELS[lot.unit];
  const writeOffable = Number(lot.quantity) > 0 && (lot.status === "EXPIRED" || lot.recalled);

  return (
    <section>
      <PageHeader
        title={`Lot ${lot.lotNumber}`}
        description={`${lot.itemName} · ${lot.branchName} · ${lot.locationName}`}
        back={{ href: `/inventory/items/${lot.inventoryItemId}#lotlar`, label: lot.itemName }}
        actions={<LotStatusBadge status={lot.status} />}
      />
      <InventoryNav current="/inventory/items" />

      {lot.recalled ? (
        <p role="alert" className="card mb-6 border-red-300 text-sm text-red-800 dark:text-red-300">
          Bu lot {lot.recalledAt ? formatDateTime(lot.recalledAt) : ""} tarihinde geri çağrıldı. Yeni hasta
          kullanımı ve transfer kapalıdır; geçmiş kayıtlar değişmez.
        </p>
      ) : lot.status === "EXPIRED" ? (
        <p role="alert" className="card mb-6 text-sm text-red-800 dark:text-red-300">
          SKT geçmiş: hasta kullanımına kapalı. Fiziksel stok imha / iade ile düşülmelidir.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid content-start gap-6">
          <dl className="card grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="label">Miktar</dt>
              <dd className="text-2xl font-bold tabular-nums">
                {formatQuantity(lot.quantity)} {unit}
              </dd>
            </div>
            <div>
              <dt className="label">SKT</dt>
              <dd className="text-lg font-semibold">{formatExpiry(lot.expiryDate)}</dd>
              {lot.daysRemaining !== null ? (
                <dd className="hint">
                  {lot.daysRemaining < 0
                    ? `${-lot.daysRemaining} gün önce doldu`
                    : lot.daysRemaining === 0
                      ? "Bugün son gün (gün sonuna kadar geçerli)"
                      : `${lot.daysRemaining} gün kaldı`}
                </dd>
              ) : null}
            </div>
            <div>
              <dt className="label">Teslim alma</dt>
              <dd>{lot.receivedAt ? formatDateTime(lot.receivedAt) : "—"}</dd>
              {lot.supplierReference ? <dd className="hint">Ref: {lot.supplierReference}</dd> : null}
            </div>
          </dl>

          {lot.siblings.length ? (
            <div className="card overflow-x-auto p-0">
              <h2 className="px-5 pt-5 font-semibold">Aynı lot — diğer lokasyonlar</h2>
              <table className="table mt-3">
                <thead>
                  <tr>
                    <th scope="col">Lokasyon</th>
                    <th scope="col">Miktar</th>
                    <th scope="col">Durum</th>
                  </tr>
                </thead>
                <tbody>
                  {lot.siblings.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link href={`/inventory/lots/${s.id}`} className="text-brand-700 hover:underline">
                          {s.branchName} · {s.locationName}
                        </Link>
                      </td>
                      <td className="tabular-nums">
                        {formatQuantity(s.quantity)} {unit}
                      </td>
                      <td>
                        <LotStatusBadge status={s.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="card overflow-x-auto p-0">
            <h2 className="px-5 pt-5 font-semibold">Lot hareketleri</h2>
            {moves.items.length === 0 ? (
              <p className="px-5 pb-5 pt-2 text-sm text-slate-500">Hareket yok.</p>
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
                      <td className="tabular-nums">{formatQuantity(m.quantity)}</td>
                      <td>{m.userName ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {can.trace ? (
            <div className="card overflow-x-auto p-0" id="izleme">
              <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
                <h2 className="font-semibold">Hasta izleme</h2>
                {trace === null ? (
                  <Link href={`/inventory/lots/${lot.id}?trace=1#izleme`} className="btn-ghost btn-sm">
                    Bu lotun kullanıldığı hastaları göster
                  </Link>
                ) : null}
              </div>
              <p className="hint px-5">
                Yalnızca hasta kimliği ve dosya numarası gösterilir; her görüntüleme kayıt altına alınır.
              </p>
              {trace === null ? (
                <div className="pb-5" />
              ) : trace.length === 0 ? (
                <p className="px-5 pb-5 pt-2 text-sm text-slate-500">Bu lot hiçbir hastada kullanılmamış.</p>
              ) : (
                <table className="table mt-3">
                  <thead>
                    <tr>
                      <th scope="col">Dosya no</th>
                      <th scope="col">Kullanım</th>
                      <th scope="col">Tarih</th>
                      <th scope="col">Şube · lokasyon</th>
                      <th scope="col">Miktar</th>
                      <th scope="col">Durum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trace.map((t) => (
                      <tr key={`${t.patientUsageId}-${t.lotNumber}-${t.locationName}`}>
                        <td className="font-mono text-xs">
                          <Link href={`/patients/${t.patientId}`} className="text-brand-700 hover:underline">
                            {t.patientNumber}
                          </Link>
                        </td>
                        <td>
                          <Link
                            href={`/inventory/usages/${t.patientUsageId}`}
                            className="text-brand-700 hover:underline"
                          >
                            Kullanım kaydı
                          </Link>
                        </td>
                        <td className="whitespace-nowrap text-xs">
                          {t.finalizedAt ? formatDateTime(t.finalizedAt) : "—"}
                        </td>
                        <td>
                          {t.branchName} · {t.locationName}
                        </td>
                        <td className="tabular-nums">{formatQuantity(t.quantity)}</td>
                        <td>
                          <UsageStatusBadge status={t.usageStatus} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : null}
        </div>

        <div className="grid content-start gap-4">
          {can.writeOff && writeOffable ? (
            <div className="card">
              <h2 className="font-semibold">İmha / iade (stoktan düş)</h2>
              <ActionForm action={writeOffLotAction} submitLabel="İmhayı kaydet" className="mt-4 grid gap-3">
                <input type="hidden" name="stockLotId" value={lot.id} />
                <input type="hidden" name="inventoryItemId" value={lot.inventoryItemId} />
                <Field
                  label={`Miktar (${unit})`}
                  name="quantity"
                  inputMode="decimal"
                  idPrefix="wo"
                  hint={`Boş bırakılırsa tamamı (${formatQuantity(lot.quantity)}).`}
                />
                <Field label="Gerekçe" name="reason" required minLength={3} maxLength={300} idPrefix="wo" />
              </ActionForm>
            </div>
          ) : null}
          {can.correct && !lot.recalled ? (
            <details className="card">
              <summary className="cursor-pointer font-semibold">SKT düzelt</summary>
              <ActionForm action={correctLotAction} submitLabel="SKT'yi düzelt" className="mt-4 grid gap-3">
                <input type="hidden" name="stockLotId" value={lot.id} />
                <input type="hidden" name="inventoryItemId" value={lot.inventoryItemId} />
                <Field
                  label="Doğru SKT"
                  name="expiryDate"
                  type="date"
                  required
                  defaultValue={lot.expiryDate ?? ""}
                  idPrefix="co"
                />
                <Field label="Gerekçe" name="reason" required minLength={5} maxLength={300} idPrefix="co" />
                <p className="hint">
                  Lot numarası değiştirilemez. Düzeltme lotun tüm lokasyonlarına uygulanır.
                </p>
              </ActionForm>
            </details>
          ) : null}
          {can.recall && !lot.recalled ? (
            <details className="card">
              <summary className="cursor-pointer font-semibold text-red-700 dark:text-red-400">
                Geri çağır
              </summary>
              <ActionForm action={recallLotAction} submitLabel="Lotu geri çağır" className="mt-4 grid gap-3">
                <input type="hidden" name="stockLotId" value={lot.id} />
                <input type="hidden" name="inventoryItemId" value={lot.inventoryItemId} />
                <Field label="Gerekçe" name="reason" required minLength={5} maxLength={500} idPrefix="rc" />
                <p className="hint">
                  Geri alınamaz. Lotun tüm lokasyonlardaki stoğu yeni kullanıma ve transfere kapanır; gerekçe
                  şifreli saklanır.
                </p>
              </ActionForm>
            </details>
          ) : null}
          {can.count ? (
            <Link href={`/inventory/items/${lot.inventoryItemId}#sayim`} className="btn-ghost">
              Fiziksel sayım
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
