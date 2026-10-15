import "server-only";
import { and, asc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { branches, inventoryLocations, stockLots } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { canAccessBranch, type AuthContext } from "@/server/auth/authz";
import { tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { PG_UNIQUE_VIOLATION, pgErrorInfo } from "@/server/db/pg-errors";
import { dateInZone } from "@/lib/time";
import { toMilli } from "@/lib/quantity";
import type { LotCandidate } from "@/server/inventory/fefo";
import { uuidSchema } from "@/server/validation";

/**
 * Lot çekirdeği — stok ve hasta kullanımı servislerinin ortak, kapsam içi (scope) yardımcıları.
 * Lot satırı = (ürün, lokasyon, lot numarası). Transfer aynı numara + SKT ile hedefte ayrı satır oluşturur;
 * "lot kimliği" ürün + lot numarasıdır (geri çağırma / izleme tüm satırları kapsar).
 */
export type LotRow = typeof stockLots.$inferSelect;

/** Lot + lokasyon şubesi (şube kapsamı dışı → NOT_FOUND). */
export async function loadLotInScope(
  scope: TenantScope,
  ctx: AuthContext,
  rawId: unknown,
): Promise<LotRow & { branchId: string; timezone: string; locationName: string }> {
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  const [row] = await scope.tx
    .select({
      lot: stockLots,
      branchId: inventoryLocations.branchId,
      locationName: inventoryLocations.name,
      timezone: branches.timezone,
    })
    .from(stockLots)
    .innerJoin(
      inventoryLocations,
      and(
        eq(inventoryLocations.id, stockLots.locationId),
        eq(inventoryLocations.tenantId, stockLots.tenantId),
      ),
    )
    .innerJoin(
      branches,
      and(eq(branches.id, inventoryLocations.branchId), eq(branches.tenantId, inventoryLocations.tenantId)),
    )
    .where(tenantWhere(stockLots, scope, eq(stockLots.id, id.data)));
  if (!row || !canAccessBranch(ctx, row.branchId)) throw new AppError("NOT_FOUND");
  return { ...row.lot, branchId: row.branchId, timezone: row.timezone, locationName: row.locationName };
}

/** Lokasyonun şubesinin yerel takvim tarihi (SKT kontrolü için — sunucu saatine göre). */
export async function locationToday(
  scope: TenantScope,
  locationId: string,
): Promise<{ today: string; timezone: string }> {
  const [r] = await scope.tx
    .select({ tz: branches.timezone })
    .from(inventoryLocations)
    .innerJoin(
      branches,
      and(eq(branches.id, inventoryLocations.branchId), eq(branches.tenantId, inventoryLocations.tenantId)),
    )
    .where(tenantWhere(inventoryLocations, scope, eq(inventoryLocations.id, locationId)));
  const timezone = r?.tz ?? "Europe/Istanbul";
  return { today: dateInZone(new Date(), timezone), timezone };
}

/**
 * Aynı (ürün, lokasyon, lot numarası) varsa onu döndürür, yoksa miktarı 0 olan yeni lot satırı açar (stok yalnızca
 * defterle gelir). Var olan lotun SKT'si farklıysa CONFLICT (aynı lot iki farklı SKT taşıyamaz).
 */
export async function findOrCreateLot(
  scope: TenantScope,
  args: {
    itemId: string;
    locationId: string;
    lotNumber: string;
    expiryDate: string | null;
    receivedAt?: Date | null;
    supplierReference?: string | null;
  },
): Promise<{ lot: LotRow; created: boolean }> {
  const find = async () =>
    (
      await scope.tx
        .select()
        .from(stockLots)
        .where(
          tenantWhere(
            stockLots,
            scope,
            eq(stockLots.inventoryItemId, args.itemId),
            eq(stockLots.locationId, args.locationId),
            eq(stockLots.lotNumber, args.lotNumber),
          ),
        )
    )[0];
  const check = (l: LotRow) => {
    // Geri çağrılmış lot satırı yeni giriş / transfer hedefi olamaz.
    if (l.recalledAt) throw new AppError("LOT_RECALLED");
    if ((l.expiryDate ?? null) !== (args.expiryDate ?? null)) {
      throw new AppError("CONFLICT", {
        message: `Lot ${args.lotNumber} bu lokasyonda farklı bir SKT ile kayıtlı; SKT düzeltmesi yetkili kullanıcıyla yapılır.`,
      });
    }
    return l;
  };
  const existing = await find();
  if (existing) return { lot: check(existing), created: false };
  // Çağıran lockLotIdentity'yi almış olmalı: geri çağrılmış lot numarası yeni lokasyonda yeniden açılamaz.
  if (await lotIdentityRecalled(scope, args.itemId, args.lotNumber)) throw new AppError("LOT_RECALLED");
  try {
    const [lot] = await scope.tx
      .insert(stockLots)
      .values({
        tenantId: scope.tenantId,
        inventoryItemId: args.itemId,
        locationId: args.locationId,
        lotNumber: args.lotNumber,
        expiryDate: args.expiryDate,
        receivedAt: args.receivedAt ?? null,
        supplierReference: args.supplierReference ?? null,
      })
      .returning();
    return { lot: lot!, created: true };
  } catch (e) {
    // Eşzamanlı aynı lot girişi: benzersizlik kısıtı → mevcut satır kullanılır.
    if (pgErrorInfo(e).code === PG_UNIQUE_VIOLATION) {
      const again = await find();
      if (again) return { lot: check(again), created: false };
    }
    throw e;
  }
}

/** FEFO adayları: ürün + lokasyondaki tüm lotlar (filtreleme saf fonksiyonda). Kilit altında çağrılmalı. */
export async function lotCandidates(
  scope: TenantScope,
  itemId: string,
  locationId: string,
): Promise<LotCandidate[]> {
  const rows = await scope.tx
    .select()
    .from(stockLots)
    .where(
      tenantWhere(
        stockLots,
        scope,
        eq(stockLots.inventoryItemId, itemId),
        eq(stockLots.locationId, locationId),
      ),
    )
    .orderBy(asc(stockLots.expiryDate), asc(stockLots.id));
  return rows.map((l) => ({
    id: l.id,
    lotNumber: l.lotNumber,
    expiryDate: l.expiryDate,
    quantityMilli: toMilli(l.quantity),
    receivedAt: l.receivedAt,
    recalled: l.recalledAt !== null,
    active: l.active,
  }));
}

/**
 * Kullanılabilir lot stoğu (SKT'si geçmemiş, geri çağrılmamış, aktif) — verilen (kiracı, ürün, lokasyon) sütun
 * ifadeleri için ilişkili alt sorgu. SKT şubenin yerel takvimine göre (lot_expired ile aynı anlam).
 */
export function usableLotSum(tenant: SQL, item: SQL, location: SQL): SQL<string> {
  return sql<string>`(select coalesce(sum(ul_lot.quantity), 0) from kliniva.stock_lots ul_lot
  join kliniva.inventory_locations ul_loc on ul_loc.tenant_id = ul_lot.tenant_id and ul_loc.id = ul_lot.location_id
  join kliniva.branches ul_br on ul_br.tenant_id = ul_loc.tenant_id and ul_br.id = ul_loc.branch_id
  where ul_lot.tenant_id = ${tenant} and ul_lot.inventory_item_id = ${item} and ul_lot.location_id = ${location}
    and ul_lot.active and ul_lot.recalled_at is null
    and (ul_lot.expiry_date is null or ul_lot.expiry_date >= (now() at time zone ul_br.timezone)::date))`;
}

/**
 * Lot kimliği kilidi (ürün + lot numarası). Lot satırı OLUŞTURAN işlemler (giriş, transfer hedefi) ve geri çağırma
 * bu kilidi lockStock'tan ÖNCE alır → geri çağırma sürerken aynı lot numarasıyla yeni satır açılamaz; sıralama
 * sabit olduğundan kilitlenme (deadlock) olmaz. Transaction sonunda bırakılır.
 */
export async function lockLotIdentity(scope: TenantScope, itemId: string, lotNumber: string) {
  await scope.tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${scope.tenantId}:lot:${itemId}:${lotNumber}`}, 0))`,
  );
}

/** Aynı ürün + lot numarasının herhangi bir lokasyondaki satırı geri çağrılmış mı? (geri çağırma lot kimliğine uygulanır) */
export async function lotIdentityRecalled(
  scope: TenantScope,
  itemId: string,
  lotNumber: string,
): Promise<boolean> {
  const [r] = await scope.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(stockLots)
    .where(
      tenantWhere(
        stockLots,
        scope,
        eq(stockLots.inventoryItemId, itemId),
        eq(stockLots.lotNumber, lotNumber),
        isNotNull(stockLots.recalledAt),
      ),
    );
  return (r?.n ?? 0) > 0;
}
