import "server-only";
import { sql } from "drizzle-orm";
import { listActiveTenantIds } from "@/server/tenant/system";
import { tenantQuery, type TenantScope } from "@/server/tenant/tenant-query";
import { enqueueOutbox } from "@/server/notifications/outbox";

/**
 * SKT taraması — sistem işi (periyodik poller / yönetim tetiklemesi). Her lot için "bugün" lotun bulunduğu
 * ŞUBENİN saat diliminde hesaplanır; uyarı penceresi klinik ayarı expiryWarningDays.
 *
 *  - Lot uyarı penceresine İLK KEZ girdiğinde → LOT_EXPIRING_SOON
 *  - Lot süresi İLK KEZ geçtiğinde        → LOT_EXPIRED (tarama ilk kez SKT sonrası görüyorsa doğrudan bu)
 * Yalnızca fiziksel miktarı > 0 ve geri çağrılmamış lotlar. İdempotent: outbox tekilleştirme anahtarı
 * (lot + SKT) → aynı tarama tekrar çalışınca YENİ olay üretmez; SKT düzeltilirse yeni anahtar → yeni uyarı.
 */
export type ExpiryScanResult = { tenants: number; expiringQueued: number; expiredQueued: number };

export async function scanExpiryNotifications(
  opts: { tenantIds?: string[] } = {},
): Promise<ExpiryScanResult> {
  const ids = opts.tenantIds ?? (await listActiveTenantIds());
  const out: ExpiryScanResult = { tenants: 0, expiringQueued: 0, expiredQueued: 0 };
  for (const tenantId of ids) {
    const r = await tenantQuery({ tenantId }, (scope) => scanTenant(scope));
    out.tenants++;
    out.expiringQueued += r.expiring;
    out.expiredQueued += r.expired;
  }
  return out;
}

async function scanTenant(scope: TenantScope): Promise<{ expiring: number; expired: number }> {
  const rows = await scope.tx.execute<{
    lot_id: string;
    item_id: string;
    location_id: string;
    branch_id: string;
    expiry: string;
    expired: boolean;
  }>(sql`
    select l.id as lot_id, l.inventory_item_id as item_id, l.location_id, loc.branch_id,
           l.expiry_date::text as expiry,
           (l.expiry_date < (now() at time zone b.timezone)::date) as expired
      from kliniva.stock_lots l
      join kliniva.inventory_locations loc on loc.tenant_id = l.tenant_id and loc.id = l.location_id
      join kliniva.branches b on b.tenant_id = loc.tenant_id and b.id = loc.branch_id
      left join kliniva.clinic_profiles cp on cp.tenant_id = l.tenant_id
     where l.tenant_id = ${scope.tenantId}::uuid
       and l.quantity > 0 and l.recalled_at is null and l.expiry_date is not null
       and l.expiry_date <= (now() at time zone b.timezone)::date + coalesce(cp.expiry_warning_days, 30)`);
  let expiring = 0;
  let expired = 0;
  for (const r of rows.rows) {
    const kind = r.expired ? "LOT_EXPIRED" : "LOT_EXPIRING_SOON";
    const q = await enqueueOutbox(scope, {
      eventType: kind,
      aggregateType: "stock_lot",
      aggregateId: r.lot_id,
      payload: {
        lotId: r.lot_id,
        itemId: r.item_id,
        locationId: r.location_id,
        branchId: r.branch_id,
        expiryDate: r.expiry,
      },
      deduplicationKey: `${kind === "LOT_EXPIRED" ? "lot-expired" : "lot-expiring"}:${r.lot_id}:${r.expiry}`,
    });
    if (q) {
      if (kind === "LOT_EXPIRED") expired++;
      else expiring++;
    }
  }
  return { expiring, expired };
}
