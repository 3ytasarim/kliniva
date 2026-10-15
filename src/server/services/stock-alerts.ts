import "server-only";
import { sql } from "drizzle-orm";
import type { TenantScope } from "@/server/tenant/tenant-query";
import { enqueueOutbox } from "@/server/notifications/outbox";
import { fromMilli, toMilli } from "@/lib/quantity";

/**
 * Stok eşik uyarıları — DURUMSUZ eşik GEÇİŞİ tespiti, stok kilidi (lockStock) ALTINDA:
 *   önce  = hareketten önceki KULLANILABİLİR stok (lot takipli üründe SKT geçmiş / geri çağrılmış / pasif lot hariç)
 *   sonra = hareketten sonraki kullanılabilir stok
 *   önce > 0  ve sonra = 0          → STOCK_OUT  (tükendi; aynı anda asgari eşiği de geçse yalnızca bu)
 *   önce > min ve sonra <= min     → STOCK_LOW  (asgari seviyeye indi)
 * Zaten düşükken (4 → 3) geçiş yoktur → yeni olay YOK. Stok yükselip (3 → 10) tekrar inerse (10 → 5) yeni geçiş →
 * yeni olay. Kilit, aynı kalem+lokasyondaki eşzamanlı hareketleri serileştirdiği için tek geçiş tek olay üretir.
 * Olay iş transaction'ına yazılır (geri alınırsa uyarı da yok).
 */
export type StockPair = { itemId: string; locationId: string };
type Snap = { usable: number; min: number | null; branchId: string; tracked: boolean };

const key = (p: StockPair) => `${p.itemId}:${p.locationId}`;

export async function usableSnapshot(scope: TenantScope, pairs: StockPair[]): Promise<Map<string, Snap>> {
  const out = new Map<string, Snap>();
  const uniq = [...new Map(pairs.map((p) => [key(p), p])).values()];
  if (!uniq.length) return out;
  const values = sql.join(
    uniq.map((p) => sql`(${p.itemId}::uuid, ${p.locationId}::uuid)`),
    sql`, `,
  );
  const r = await scope.tx.execute<{
    item_id: string;
    location_id: string;
    branch_id: string;
    minimum: string | null;
    tracked: boolean;
    usable: string;
  }>(sql`
    with p(item_id, location_id) as (values ${values})
    select p.item_id, p.location_id, l.branch_id, i.minimum_stock_level as minimum,
           (i.track_inventory and i.active) as tracked,
           case when i.track_lots then
             (select coalesce(sum(sl.quantity), 0) from kliniva.stock_lots sl
               join kliniva.branches br on br.tenant_id = l.tenant_id and br.id = l.branch_id
              where sl.tenant_id = i.tenant_id and sl.inventory_item_id = i.id and sl.location_id = l.id
                and sl.active and sl.recalled_at is null
                and (sl.expiry_date is null or sl.expiry_date >= (now() at time zone br.timezone)::date))
           else coalesce((select b.quantity from kliniva.stock_balances b
                           where b.tenant_id = i.tenant_id and b.inventory_item_id = i.id and b.location_id = l.id), 0)
           end as usable
      from p
      join kliniva.inventory_items i on i.tenant_id = ${scope.tenantId}::uuid and i.id = p.item_id
      join kliniva.inventory_locations l on l.tenant_id = ${scope.tenantId}::uuid and l.id = p.location_id`);
  for (const row of r.rows) {
    out.set(`${row.item_id}:${row.location_id}`, {
      usable: toMilli(row.usable),
      min: row.minimum === null ? null : toMilli(row.minimum),
      branchId: row.branch_id,
      tracked: row.tracked,
    });
  }
  return out;
}

/** Saf geçiş kararı (birim test edilir). */
export function stockCrossing(
  prev: number,
  next: number,
  min: number | null,
): "STOCK_OUT" | "STOCK_LOW" | null {
  if (prev > 0 && next <= 0) return "STOCK_OUT";
  if (min !== null && prev > min && next <= min) return "STOCK_LOW";
  return null;
}

/** Hareket SONRASI çağrılır: önceki anlık görüntüyle karşılaştırır, geçiş varsa outbox olayı ekler. */
export async function emitStockAlerts(scope: TenantScope, before: Map<string, Snap>): Promise<number> {
  if (!before.size) return 0;
  const pairs = [...before.keys()].map((k) => {
    const [itemId, locationId] = k.split(":");
    return { itemId: itemId!, locationId: locationId! };
  });
  const after = await usableSnapshot(scope, pairs);
  let emitted = 0;
  for (const p of pairs) {
    const b = before.get(key(p));
    const a = after.get(key(p));
    if (!b || !a || !a.tracked) continue;
    const kind = stockCrossing(b.usable, a.usable, a.min);
    if (!kind) continue;
    await enqueueOutbox(scope, {
      eventType: kind,
      aggregateType: "inventory_item",
      aggregateId: p.itemId,
      payload: {
        itemId: p.itemId,
        locationId: p.locationId,
        branchId: a.branchId,
        usable: Number(fromMilli(a.usable)),
        minimum: a.min === null ? null : Number(fromMilli(a.min)),
      },
    });
    emitted++;
  }
  return emitted;
}
