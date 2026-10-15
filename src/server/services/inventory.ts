import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import {
  branches,
  inventoryCategories,
  inventoryItems,
  inventoryLocations,
  rooms,
  stockBalances,
  stockLots,
  stockMovements,
  users,
} from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit, type AuditAction } from "@/server/audit/audit";
import {
  actorOf,
  canAccessBranch,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "@/server/auth/authz";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorInfo } from "@/server/db/pg-errors";
import {
  addStockInput,
  adjustStockInput,
  categoryInput,
  fromMilli,
  getInventoryInput,
  itemInput,
  listItemsInput,
  listMovementsInput,
  locationInput,
  reconcileInput,
  toMilli,
  transferStockInput,
} from "@/server/inventory/contracts";
import { addDays, zonedDateTimeToUtc, dateInZone, DEFAULT_TIMEZONE } from "@/lib/time";
import { clinicProfiles } from "@/server/db/schema";
import { uuidSchema } from "@/server/validation";
import {
  findOrCreateLot,
  loadLotInScope,
  lockLotIdentity,
  usableLotSum,
  type LotRow,
} from "@/server/services/lot-core";
import { emitStockAlerts, usableSnapshot } from "@/server/services/stock-alerts";

/**
 * Stok uygulama servisleri — HTTP / AI bağımsız. Her çağrı: yetki + kiracı (RLS) + şube kapsamı (lokasyon şubesi).
 *
 * DEFTER MODELİ
 *  - stock_movements kaynak gerçektir ve yalnızca eklenir. Düzeltme = ters hareket.
 *  - stock_balances'ı yalnızca DB tetikleyicisi günceller (uygulama rolü bakiyeye yazamaz).
 *  - Her stok değişimi tek transaction: advisory lock (kalem+lokasyon, deterministik sıra) → mevcut miktar
 *    kontrolü → hareket INSERT (tetikleyici bakiyeyi atomik ve koşullu günceller) → audit.
 *  - Negatif stok yok: servis kontrolü + tetikleyicinin koşullu UPDATE'i + CHECK (quantity >= 0).
 * Audit'e hasta adı / telefon / not YAZILMAZ — yalnızca kimlikler, miktar ve hareket tipi.
 */

export function parseId(raw: unknown): string {
  const id = uuidSchema.safeParse(raw);
  if (!id.success) throw new AppError("NOT_FOUND");
  return id.data;
}

const mapUnique = (e: unknown): never => {
  const info = pgErrorInfo(e);
  if (info.code === PG_UNIQUE_VIOLATION) {
    throw new AppError("CONFLICT", { message: "Aynı ad / kod / barkod ile kayıt zaten var." });
  }
  if (info.code === PG_FOREIGN_KEY_VIOLATION) throw new AppError("NOT_FOUND");
  throw e;
};

/** Hareket ekleme hatalarını uygulama koduna çevirir (yetersiz stok tetikleyicisi dahil). */
export function mapMovementError(e: unknown): never {
  const info = pgErrorInfo(e);
  const msg = String(
    ((e as { cause?: { message?: unknown } })?.cause ?? (e as { message?: unknown }))?.message ?? "",
  );
  if (/KLINIVA_INSUFFICIENT_STOCK/.test(msg) || info.code === "23514")
    throw new AppError("INSUFFICIENT_STOCK");
  // Lot korumaları (DB tetikleyicisi — servis kontrolünü atlatan yarışlarda son savunma).
  if (/KLINIVA_LOT_EXPIRED/.test(msg)) throw new AppError("LOT_EXPIRED");
  if (/KLINIVA_LOT_RECALLED/.test(msg)) throw new AppError("LOT_RECALLED");
  if (/KLINIVA_LOT_INACTIVE/.test(msg))
    throw new AppError("VALIDATION", { fields: ["stockLotId"], message: "Lot aktif değil." });
  if (/KLINIVA_INVALID: (lot-tracked movement requires lot|lot on non lot-tracked item)/.test(msg)) {
    // Takip modu eşzamanlı değişti → istemci yeniden denemeli.
    throw new AppError("CONFLICT", {
      message: "Ürünün lot takip modu değişti; sayfayı yenileyip tekrar deneyin.",
    });
  }
  if (info.code === PG_FOREIGN_KEY_VIOLATION) throw new AppError("NOT_FOUND");
  throw e;
}

/** Deterministik sırada advisory lock (kalem+lokasyon). Transaction sonunda bırakılır. */
export async function lockStock(scope: TenantScope, pairs: { itemId: string; locationId: string }[]) {
  const keys = [...new Set(pairs.map((p) => `${p.itemId}:${p.locationId}`))].sort();
  for (const k of keys) {
    await scope.tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${scope.tenantId}:stock:${k}`}, 0))`,
    );
  }
}

/** Kilit ALTINDA okunmalı. Binde birim tamsayı döner. */
export async function balanceMilli(scope: TenantScope, itemId: string, locationId: string): Promise<number> {
  const [b] = await scope.tx
    .select({ q: stockBalances.quantity })
    .from(stockBalances)
    .where(
      tenantWhere(
        stockBalances,
        scope,
        eq(stockBalances.inventoryItemId, itemId),
        eq(stockBalances.locationId, locationId),
      ),
    );
  return b ? toMilli(b.q) : 0;
}

/** Şube kapsamı SQL koşulu (lokasyon şubesi). Kiracı geneli kullanıcıda undefined. */
export function locationScope(
  ctx: AuthContext,
  column: PgColumn = inventoryLocations.branchId,
): SQL | undefined {
  if (ctx.branchScope.all) return undefined;
  const ids = [...ctx.branchScope.branchIds];
  return ids.length ? inArray(column, ids) : sql`false`;
}

export type LocationRow = {
  id: string;
  branchId: string;
  branchName: string;
  type: "BRANCH_WAREHOUSE" | "ROOM";
  roomId: string | null;
  name: string;
  active: boolean;
};

const locationColumns = {
  id: inventoryLocations.id,
  branchId: inventoryLocations.branchId,
  branchName: branches.name,
  type: inventoryLocations.type,
  roomId: inventoryLocations.roomId,
  name: inventoryLocations.name,
  active: inventoryLocations.active,
};

/** Görünür lokasyon (şube kapsamı dışı → NOT_FOUND; varlık sızdırılmaz). */
export async function loadLocation(
  scope: TenantScope,
  ctx: AuthContext,
  rawId: unknown,
  opts: { requireActive?: boolean; anyBranch?: boolean } = {},
): Promise<LocationRow> {
  const id = parseId(rawId);
  const [row] = await scope.tx
    .select(locationColumns)
    .from(inventoryLocations)
    .innerJoin(
      branches,
      and(eq(branches.id, inventoryLocations.branchId), eq(branches.tenantId, inventoryLocations.tenantId)),
    )
    .where(tenantWhere(inventoryLocations, scope, eq(inventoryLocations.id, id)));
  if (!row) throw new AppError("NOT_FOUND");
  if (!opts.anyBranch && !canAccessBranch(ctx, row.branchId)) throw new AppError("NOT_FOUND");
  if (opts.requireActive && !row.active) {
    throw new AppError("VALIDATION", { fields: ["locationId"], message: "Lokasyon aktif değil." });
  }
  return row;
}

/**
 * Ürün yükleme. forStock: stok hareketi öncesi — satır FOR SHARE kilitlenir; böylece lot takip modu değişikliği
 * (updateInventoryItem, FOR UPDATE) ile stok hareketleri birbirini bekler: mod, hareket sürerken değişemez.
 */
export async function loadItem(scope: TenantScope, rawId: unknown, opts: { forStock?: boolean } = {}) {
  const id = parseId(rawId);
  const q = scope.tx
    .select()
    .from(inventoryItems)
    .where(tenantWhere(inventoryItems, scope, eq(inventoryItems.id, id)));
  const [item] = opts.forStock ? await q.for("share") : await q;
  if (!item) throw new AppError("NOT_FOUND");
  if (opts.forStock) {
    if (!item.active)
      throw new AppError("VALIDATION", { fields: ["inventoryItemId"], message: "Ürün aktif değil." });
    if (!item.trackInventory) {
      throw new AppError("VALIDATION", {
        fields: ["inventoryItemId"],
        message: "Bu ürün için stok takibi kapalı.",
      });
    }
  }
  return item;
}

/** Lot takipli üründe hareket için lot: AYNI ürün + AYNI lokasyonda olmalı (aksi NOT_FOUND — varlık sızdırılmaz). */
async function loadMovementLot(
  scope: TenantScope,
  ctx: AuthContext,
  item: { id: string; trackLots: boolean },
  locationId: string,
  rawLotId: string | undefined,
  field: string,
): Promise<LotRow | null> {
  if (!item.trackLots) {
    if (rawLotId)
      throw new AppError("VALIDATION", { fields: [field], message: "Bu ürün lot takipli değil." });
    return null;
  }
  if (!rawLotId) throw new AppError("VALIDATION", { fields: [field], message: "Lot seçimi zorunlu." });
  const lot = await loadLotInScope(scope, ctx, rawLotId);
  if (lot.inventoryItemId !== item.id || lot.locationId !== locationId) throw new AppError("NOT_FOUND");
  return lot;
}

/** Kilit ALTINDA lot miktarı (binde birim). */
async function lotMilli(scope: TenantScope, lotId: string): Promise<number> {
  const [l] = await scope.tx
    .select({ q: stockLots.quantity })
    .from(stockLots)
    .where(tenantWhere(stockLots, scope, eq(stockLots.id, lotId)));
  return l ? toMilli(l.q) : 0;
}

async function lotAudit(
  scope: TenantScope,
  ctx: AuthContext,
  action: AuditAction,
  lot: { id: string; inventoryItemId: string; locationId: string },
  branchId: string | null,
  extra: Record<string, string | number | boolean | null> = {},
) {
  await writeAudit(scope, actorOf(ctx), {
    action,
    entityType: "stock_lot",
    entityId: lot.id,
    branchId,
    metadata: { lotId: lot.id, itemId: lot.inventoryItemId, locationId: lot.locationId, ...extra },
  });
}

async function stockAudit(
  scope: TenantScope,
  ctx: AuthContext,
  action: AuditAction,
  m: {
    itemId: string;
    locationId: string | null;
    branchId: string | null;
    quantity: string;
    movementType: string;
  },
  extra: Record<string, string | number | boolean | null> = {},
) {
  await writeAudit(scope, actorOf(ctx), {
    action,
    entityType: "inventory_item",
    entityId: m.itemId,
    branchId: m.branchId,
    metadata: {
      itemId: m.itemId,
      locationId: m.locationId,
      branchId: m.branchId,
      quantity: m.quantity,
      movementType: m.movementType,
      ...extra,
    },
  });
}

// ---------------------------------------------------------------- kategoriler

export async function listCategories(ctx: AuthContext) {
  requirePermission(ctx, "inventory.read");
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select()
      .from(inventoryCategories)
      .where(tenantWhere(inventoryCategories, scope))
      .orderBy(asc(inventoryCategories.name)),
  );
}

export async function createCategory(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "inventory.item.create");
  const data = parseInput(categoryInput, input);
  return tenantQuery(ctx, async (scope) => {
    const [row] = await scope.tx
      .insert(inventoryCategories)
      .values({
        tenantId: scope.tenantId,
        name: data.name,
        description: data.description ?? null,
        active: data.active,
      })
      .returning({ id: inventoryCategories.id })
      .catch(mapUnique);
    await writeAudit(scope, actorOf(ctx), {
      action: "INVENTORY_CATEGORY_CREATED",
      entityType: "inventory_category",
      entityId: row!.id,
    });
    return { id: row!.id };
  });
}

export async function updateCategory(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "inventory.item.update");
  const id = parseId(rawId);
  const data = parseInput(categoryInput, input);
  await tenantQuery(ctx, async (scope) => {
    const r = await scope.tx
      .update(inventoryCategories)
      .set({
        name: data.name,
        description: data.description ?? null,
        active: data.active,
        updatedAt: new Date(),
      })
      .where(tenantWhere(inventoryCategories, scope, eq(inventoryCategories.id, id)))
      .returning({ id: inventoryCategories.id })
      .catch(mapUnique);
    if (!r.length) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: "INVENTORY_CATEGORY_UPDATED",
      entityType: "inventory_category",
      entityId: id,
      metadata: { active: data.active },
    });
  });
}

// ---------------------------------------------------------------- ürünler

export type InventoryItemListItem = {
  id: string;
  name: string;
  code: string | null;
  barcode: string | null;
  unit: string;
  categoryId: string | null;
  categoryName: string | null;
  minimumStockLevel: string | null;
  trackInventory: boolean;
  active: boolean;
  /** Kullanıcının görebildiği lokasyonlardaki toplam (fiziksel). */
  totalStock: string;
  /** Kullanılabilir: lot takipli üründe SKT'si geçmiş / geri çağrılmış / pasif lotlar hariç. */
  usableStock: string;
  trackLots: boolean;
  trackExpiry: boolean;
  /** Kritik stok kullanılabilir stoğa göre. */
  lowStock: boolean;
};

/**
 * Bakiye satırının kullanılabilir miktarı: lot takipli üründe kullanılabilir lot toplamı, değilse bakiye.
 * `b` = stock_balances takma adı, `itemTrackLots` = ürünün track_lots ifadesi.
 */
function usableOf(b: string, itemTrackLots: SQL): SQL<string> {
  const ref = (c: string) => sql.raw(`${b}.${c}`);
  return sql<string>`(case when ${itemTrackLots} then ${usableLotSum(ref("tenant_id"), ref("inventory_item_id"), ref("location_id"))} else ${ref("quantity")} end)`;
}

/** Görünür lokasyonlardaki toplam stok (tek alt sorgu — N+1 yok). usable: kullanılabilir stok toplamı. */
function totalStockExpr(ctx: AuthContext, opts: { usable?: boolean } = {}) {
  const scoped = ctx.branchScope.all
    ? sql``
    : sql` and l.branch_id in (${sql.join(
        [...ctx.branchScope.branchIds].map((b) => sql`${b}::uuid`),
        sql`, `,
      )})`;
  if (!ctx.branchScope.all && ctx.branchScope.branchIds.size === 0) return sql<string>`0::numeric`;
  const value = opts.usable ? usableOf("b", sql`kliniva.inventory_items.track_lots`) : sql`b.quantity`;
  return sql<string>`(select coalesce(sum(${value}), 0) from kliniva.stock_balances b
    join kliniva.inventory_locations l on l.tenant_id = b.tenant_id and l.id = b.location_id
    where b.tenant_id = kliniva.inventory_items.tenant_id and b.inventory_item_id = kliniva.inventory_items.id${scoped})`;
}

export async function listInventoryItems(
  ctx: AuthContext,
  input: unknown = {},
): Promise<{ items: InventoryItemListItem[]; total: number; page: number; limit: number }> {
  requirePermission(ctx, "inventory.read");
  const data = parseInput(listItemsInput, input);
  return tenantQuery(ctx, async (scope) => {
    const conds: (SQL | undefined)[] = [
      data.status === "all" ? undefined : eq(inventoryItems.active, data.status === "active"),
      data.categoryId ? eq(inventoryItems.categoryId, data.categoryId) : undefined,
    ];
    if (data.q) {
      const like = `%${data.q.replace(/[%_\\]/g, "\\$&")}%`;
      conds.push(
        or(
          ilike(inventoryItems.name, like),
          ilike(inventoryItems.code, like),
          eq(inventoryItems.barcode, data.q),
        ),
      );
    }
    const where = tenantWhere(inventoryItems, scope, ...conds);
    const [{ n }] = (await scope.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(inventoryItems)
      .where(where)) as [{ n: number }];
    const total = totalStockExpr(ctx);
    const usable = totalStockExpr(ctx, { usable: true });
    const rows = await scope.tx
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        code: inventoryItems.code,
        barcode: inventoryItems.barcode,
        unit: inventoryItems.unit,
        categoryId: inventoryItems.categoryId,
        categoryName: inventoryCategories.name,
        minimumStockLevel: inventoryItems.minimumStockLevel,
        trackInventory: inventoryItems.trackInventory,
        trackLots: inventoryItems.trackLots,
        trackExpiry: inventoryItems.trackExpiry,
        active: inventoryItems.active,
        totalStock: total,
        usableStock: usable,
      })
      .from(inventoryItems)
      .leftJoin(
        inventoryCategories,
        and(
          eq(inventoryCategories.id, inventoryItems.categoryId),
          eq(inventoryCategories.tenantId, inventoryItems.tenantId),
        ),
      )
      .where(where)
      .orderBy(asc(inventoryItems.name))
      .limit(data.limit)
      .offset((data.page - 1) * data.limit);
    return {
      items: rows.map((r) => ({
        ...r,
        totalStock: String(r.totalStock),
        usableStock: String(r.usableStock),
        lowStock: r.minimumStockLevel !== null && toMilli(r.usableStock) <= toMilli(r.minimumStockLevel),
      })),
      total: n,
      page: data.page,
      limit: data.limit,
    };
  });
}

function itemValues(data: ReturnType<typeof itemInput.parse>) {
  return {
    name: data.name,
    code: data.code ?? null,
    barcode: data.barcode ?? null,
    categoryId: data.categoryId ?? null,
    unit: data.unit,
    trackInventory: data.trackInventory,
    minimumStockLevel: data.minimumStockLevel ?? null,
    description: data.description ?? null,
    active: data.active,
    trackLots: data.trackLots,
    trackExpiry: data.trackExpiry,
  };
}

/** Yeni ürün — stok sayısı UYDURULMAZ; ilk stok ayrı işlemdir (addStock INITIAL_STOCK). */
export async function createInventoryItem(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "inventory.item.create");
  const data = parseInput(itemInput, input);
  return tenantQuery(ctx, async (scope) => {
    const [row] = await scope.tx
      .insert(inventoryItems)
      .values({ tenantId: scope.tenantId, ...itemValues(data) })
      .returning({ id: inventoryItems.id })
      .catch(mapUnique);
    await writeAudit(scope, actorOf(ctx), {
      action: "INVENTORY_ITEM_CREATED",
      entityType: "inventory_item",
      entityId: row!.id,
      metadata: { itemId: row!.id, unit: data.unit, trackInventory: data.trackInventory },
    });
    return { id: row!.id };
  });
}

export async function updateInventoryItem(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "inventory.item.update");
  const id = parseId(rawId);
  const data = parseInput(itemInput, input);
  await tenantQuery(ctx, async (scope) => {
    // FOR UPDATE: süren stok hareketleri (FOR SHARE) bitene kadar bekler; mod kontrolü güncel veriyle yapılır.
    const [before] = await scope.tx
      .select()
      .from(inventoryItems)
      .where(tenantWhere(inventoryItems, scope, eq(inventoryItems.id, id)))
      .for("update");
    if (!before) throw new AppError("NOT_FOUND");
    await assertTrackingModeChange(scope, before, data);
    if (before.unit !== data.unit) {
      const [m] = await scope.tx
        .select({ n: sql<number>`count(*)::int` })
        .from(stockMovements)
        .where(tenantWhere(stockMovements, scope, eq(stockMovements.inventoryItemId, id)));
      if ((m?.n ?? 0) > 0) {
        throw new AppError("VALIDATION", {
          fields: ["unit"],
          message: "Hareketi olan ürünün birimi değiştirilemez.",
        });
      }
    }
    await scope.tx
      .update(inventoryItems)
      .set({ ...itemValues(data), updatedAt: new Date() })
      .where(tenantWhere(inventoryItems, scope, eq(inventoryItems.id, id)))
      .catch(mapUnique);
    await writeAudit(scope, actorOf(ctx), {
      action: before.active && !data.active ? "INVENTORY_ITEM_DEACTIVATED" : "INVENTORY_ITEM_UPDATED",
      entityType: "inventory_item",
      entityId: id,
      metadata: { itemId: id, active: data.active, trackLots: data.trackLots, trackExpiry: data.trackExpiry },
    });
  });
}

/**
 * Takip modu kuralları — mevcut defter ve stok ASLA uydurma lotlarla dönüştürülmez:
 *  - lot takibini AÇMAK: üründe (tüm kiracıda) fiziksel stok varsa TRACKING_MODE_CHANGE_REQUIRES_MIGRATION
 *    (önce stok sıfırlanmalı / sayım ile düşülmeli; geçmiş hareketler olduğu gibi kalır).
 *  - lot takibini KAPATMAK: herhangi bir lot satırı (geçmişi) varsa LOT_TRACKING_ALREADY_IN_USE.
 *  - SKT takibini AÇMAK: SKT'siz lot satırı varsa TRACKING_MODE_CHANGE_REQUIRES_MIGRATION.
 */
async function assertTrackingModeChange(
  scope: TenantScope,
  before: { id: string; trackLots: boolean; trackExpiry: boolean },
  next: { trackLots: boolean; trackExpiry: boolean },
) {
  if (!before.trackLots && next.trackLots) {
    const [s] = await scope.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(stockBalances)
      .where(
        tenantWhere(
          stockBalances,
          scope,
          eq(stockBalances.inventoryItemId, before.id),
          sql`${stockBalances.quantity} > 0`,
        ),
      );
    if ((s?.n ?? 0) > 0) throw new AppError("TRACKING_MODE_CHANGE_REQUIRES_MIGRATION");
  }
  if (before.trackLots && !next.trackLots) {
    const [l] = await scope.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(stockLots)
      .where(tenantWhere(stockLots, scope, eq(stockLots.inventoryItemId, before.id)));
    if ((l?.n ?? 0) > 0) throw new AppError("LOT_TRACKING_ALREADY_IN_USE");
  }
  if (!before.trackExpiry && next.trackExpiry) {
    const [l] = await scope.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(stockLots)
      .where(
        tenantWhere(
          stockLots,
          scope,
          eq(stockLots.inventoryItemId, before.id),
          sql`${stockLots.expiryDate} is null`,
        ),
      );
    if ((l?.n ?? 0) > 0) throw new AppError("TRACKING_MODE_CHANGE_REQUIRES_MIGRATION");
  }
}

export type StockByLocationRow = {
  itemId: string;
  itemName: string;
  unit: string;
  locationId: string;
  locationName: string;
  locationType: string;
  branchId: string;
  branchName: string;
  /** Fiziksel (raftaki) miktar. */
  quantity: string;
  /** Kullanılabilir miktar (lot takipli üründe SKT geçmiş / geri çağrılmış / pasif lotlar hariç). */
  usableQuantity: string;
  trackLots: boolean;
  minimumStockLevel: string | null;
};

/** stockRows içindeki stock_balances satırı için kullanılabilir miktar. */
const balanceUsable = () => usableOf("kliniva.stock_balances", sql`kliniva.inventory_items.track_lots`);

async function stockRows(
  scope: TenantScope,
  ctx: AuthContext,
  conds: (SQL | undefined)[],
): Promise<StockByLocationRow[]> {
  return scope.tx
    .select({
      itemId: inventoryItems.id,
      itemName: inventoryItems.name,
      unit: inventoryItems.unit,
      locationId: inventoryLocations.id,
      locationName: inventoryLocations.name,
      locationType: inventoryLocations.type,
      branchId: branches.id,
      branchName: branches.name,
      quantity: stockBalances.quantity,
      usableQuantity: balanceUsable(),
      trackLots: inventoryItems.trackLots,
      minimumStockLevel: inventoryItems.minimumStockLevel,
    })
    .from(stockBalances)
    .innerJoin(
      inventoryItems,
      and(
        eq(inventoryItems.id, stockBalances.inventoryItemId),
        eq(inventoryItems.tenantId, stockBalances.tenantId),
      ),
    )
    .innerJoin(
      inventoryLocations,
      and(
        eq(inventoryLocations.id, stockBalances.locationId),
        eq(inventoryLocations.tenantId, stockBalances.tenantId),
      ),
    )
    .innerJoin(
      branches,
      and(eq(branches.id, inventoryLocations.branchId), eq(branches.tenantId, inventoryLocations.tenantId)),
    )
    .where(tenantWhere(stockBalances, scope, locationScope(ctx), ...conds))
    .orderBy(
      asc(branches.name),
      asc(inventoryLocations.type),
      asc(inventoryLocations.name),
      asc(inventoryItems.name),
    );
}

export async function getInventoryItem(ctx: AuthContext, rawId: unknown) {
  requirePermission(ctx, "inventory.read");
  return tenantQuery(ctx, async (scope) => {
    const item = await loadItem(scope, rawId);
    const [cat] = item.categoryId
      ? await scope.tx
          .select({ name: inventoryCategories.name })
          .from(inventoryCategories)
          .where(tenantWhere(inventoryCategories, scope, eq(inventoryCategories.id, item.categoryId)))
      : [];
    const stock = await stockRows(scope, ctx, [eq(stockBalances.inventoryItemId, item.id)]);
    const totalMilli = stock.reduce((a, r) => a + toMilli(r.quantity), 0);
    const usableMilli = stock.reduce((a, r) => a + toMilli(r.usableQuantity), 0);
    return {
      ...item,
      categoryName: cat?.name ?? null,
      stockByLocation: stock,
      totalStock: fromMilli(totalMilli),
      usableStock: fromMilli(usableMilli),
      lowStock: item.minimumStockLevel !== null && usableMilli <= toMilli(item.minimumStockLevel),
    };
  });
}

/** Lokasyon / şube / kategori filtresiyle stok tablosu. */
export async function getStockByLocation(
  ctx: AuthContext,
  input: unknown = {},
): Promise<StockByLocationRow[]> {
  requirePermission(ctx, "inventory.read");
  const data = parseInput(getInventoryInput, input);
  return tenantQuery(ctx, (scope) =>
    stockRows(scope, ctx, [
      data.branchId ? eq(inventoryLocations.branchId, data.branchId) : undefined,
      data.locationId ? eq(inventoryLocations.id, data.locationId) : undefined,
      data.categoryId ? eq(inventoryItems.categoryId, data.categoryId) : undefined,
    ]),
  );
}

// ---------------------------------------------------------------- lokasyonlar

export async function listLocations(
  ctx: AuthContext,
  opts: { branchId?: string; activeOnly?: boolean } = {},
): Promise<LocationRow[]> {
  requirePermission(ctx, "inventory.read");
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select(locationColumns)
      .from(inventoryLocations)
      .innerJoin(
        branches,
        and(eq(branches.id, inventoryLocations.branchId), eq(branches.tenantId, inventoryLocations.tenantId)),
      )
      .where(
        tenantWhere(
          inventoryLocations,
          scope,
          locationScope(ctx),
          opts.branchId ? eq(inventoryLocations.branchId, opts.branchId) : undefined,
          opts.activeOnly ? eq(inventoryLocations.active, true) : undefined,
        ),
      )
      .orderBy(asc(branches.name), asc(inventoryLocations.type), asc(inventoryLocations.name)),
  );
}

/**
 * Lokasyon: şube deposu veya oda (oda başına tek lokasyon, oda AYNI şubede — bileşik FK). Oda adı varsayılan ad olur.
 */
export async function createLocation(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "inventory.item.create");
  const data = parseInput(locationInput, input);
  if (!canAccessBranch(ctx, data.branchId)) throw new AppError("NOT_FOUND");
  return tenantQuery(ctx, async (scope) => {
    let name = data.name;
    if (data.type === "ROOM") {
      const [room] = await scope.tx
        .select({ name: rooms.name, branchId: rooms.branchId })
        .from(rooms)
        .where(tenantWhere(rooms, scope, eq(rooms.id, data.roomId!)));
      if (!room || room.branchId !== data.branchId) throw new AppError("NOT_FOUND");
      name ??= room.name;
    }
    if (!name) throw new AppError("VALIDATION", { fields: ["name"] });
    const [row] = await scope.tx
      .insert(inventoryLocations)
      .values({
        tenantId: scope.tenantId,
        branchId: data.branchId,
        type: data.type,
        roomId: data.roomId ?? null,
        name,
      })
      .returning({ id: inventoryLocations.id })
      .catch(mapUnique);
    await writeAudit(scope, actorOf(ctx), {
      action: "INVENTORY_LOCATION_CREATED",
      entityType: "inventory_location",
      entityId: row!.id,
      branchId: data.branchId,
      metadata: { locationId: row!.id, branchId: data.branchId, type: data.type },
    });
    return { id: row!.id };
  });
}

export async function setLocationActive(ctx: AuthContext, rawId: unknown, active: boolean): Promise<void> {
  requirePermission(ctx, "inventory.item.update");
  await tenantQuery(ctx, async (scope) => {
    const loc = await loadLocation(scope, ctx, rawId);
    await scope.tx
      .update(inventoryLocations)
      .set({ active, updatedAt: new Date() })
      .where(tenantWhere(inventoryLocations, scope, eq(inventoryLocations.id, loc.id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "INVENTORY_LOCATION_UPDATED",
      entityType: "inventory_location",
      entityId: loc.id,
      branchId: loc.branchId,
      metadata: { locationId: loc.id, active },
    });
  });
}

/** Randevu odası için önerilen kaynak: odanın lokasyonu, yoksa şubenin ilk aktif deposu. */
export async function defaultLocationFor(
  scope: TenantScope,
  branchId: string,
  roomId: string | null,
): Promise<string | null> {
  const rows = await scope.tx
    .select({ id: inventoryLocations.id, roomId: inventoryLocations.roomId, type: inventoryLocations.type })
    .from(inventoryLocations)
    .where(
      tenantWhere(
        inventoryLocations,
        scope,
        eq(inventoryLocations.branchId, branchId),
        eq(inventoryLocations.active, true),
      ),
    )
    .orderBy(asc(inventoryLocations.createdAt));
  return (
    (roomId ? rows.find((r) => r.roomId === roomId)?.id : undefined) ??
    rows.find((r) => r.type === "BRANCH_WAREHOUSE")?.id ??
    null
  );
}

// ---------------------------------------------------------------- stok hareketleri

/** Stok girişi: INITIAL_STOCK (kalem+lokasyon için yalnızca bir kez, öncesinde hareket yoksa) veya PURCHASE. */
export async function addStock(
  ctx: AuthContext,
  input: unknown,
): Promise<{ movementId: string; balance: string; stockLotId: string | null }> {
  requirePermission(ctx, "inventory.stock.add");
  const data = parseInput(addStockInput, input);
  return tenantQuery(ctx, async (scope) => {
    const item = await loadItem(scope, data.inventoryItemId, { forStock: true });
    if (item.trackLots) requirePermission(ctx, "inventory.lot.manage");
    const loc = await loadLocation(scope, ctx, data.locationId, { requireActive: true });
    if (item.trackLots) {
      const missing = [
        !data.lotNumber ? "lotNumber" : null,
        item.trackExpiry && !data.expiryDate ? "expiryDate" : null,
      ].filter((f): f is string => f !== null);
      if (missing.length) {
        throw new AppError("VALIDATION", {
          fields: missing,
          message: "Lot takipli üründe lot numarası (ve SKT) zorunlu.",
        });
      }
      // Kilit sırası: lot kimliği → stok (geri çağırma ile aynı sıra).
      await lockLotIdentity(scope, item.id, data.lotNumber!);
    } else if (data.lotNumber || data.expiryDate) {
      throw new AppError("VALIDATION", { fields: ["lotNumber"], message: "Bu ürün lot takipli değil." });
    }
    await lockStock(scope, [{ itemId: item.id, locationId: loc.id }]);
    if (data.kind === "INITIAL_STOCK") {
      const [prev] = await scope.tx
        .select({ n: sql<number>`count(*)::int` })
        .from(stockMovements)
        .where(
          tenantWhere(
            stockMovements,
            scope,
            eq(stockMovements.inventoryItemId, item.id),
            or(eq(stockMovements.toLocationId, loc.id), eq(stockMovements.fromLocationId, loc.id)),
          ),
        );
      if ((prev?.n ?? 0) > 0) {
        throw new AppError("CONFLICT", {
          message: "Bu lokasyonda zaten hareket var; ilk stok yerine alım veya düzeltme kullanın.",
        });
      }
    }
    // Lot: aynı (ürün, lokasyon, numara) varsa ona eklenir, yoksa boş lot açılır; miktar YALNIZCA hareketle gelir.
    const lotRes = item.trackLots
      ? await findOrCreateLot(scope, {
          itemId: item.id,
          locationId: loc.id,
          lotNumber: data.lotNumber!,
          expiryDate: data.expiryDate ?? null,
          receivedAt: data.receivedAt ? new Date(`${data.receivedAt}T00:00:00Z`) : new Date(),
          supplierReference: data.reference ?? null,
        })
      : null;
    const [m] = await scope.tx
      .insert(stockMovements)
      .values({
        tenantId: scope.tenantId,
        inventoryItemId: item.id,
        movementType: data.kind,
        toLocationId: loc.id,
        toStockLotId: lotRes?.lot.id ?? null,
        quantity: data.quantity,
        reference: data.reference ?? null,
        reason: data.reason ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: stockMovements.id })
      .catch(mapMovementError);
    await stockAudit(scope, ctx, data.kind === "INITIAL_STOCK" ? "STOCK_INITIALIZED" : "STOCK_ADDED", {
      itemId: item.id,
      locationId: loc.id,
      branchId: loc.branchId,
      quantity: data.quantity,
      movementType: data.kind,
    });
    if (lotRes) {
      if (lotRes.created) {
        await lotAudit(scope, ctx, "LOT_CREATED", lotRes.lot, loc.branchId, {
          hasExpiry: lotRes.lot.expiryDate !== null,
        });
      }
      await lotAudit(scope, ctx, "LOT_STOCK_ADDED", lotRes.lot, loc.branchId, {
        quantity: data.quantity,
        movementType: data.kind,
      });
    }
    return {
      movementId: m!.id,
      balance: fromMilli(await balanceMilli(scope, item.id, loc.id)),
      stockLotId: lotRes?.lot.id ?? null,
    };
  });
}

/** Düzeltme: IN → ADJUSTMENT_IN; OUT → ADJUSTMENT_OUT veya WRITE_OFF. Gerekçe zorunlu. */
export async function adjustStock(
  ctx: AuthContext,
  input: unknown,
): Promise<{ movementId: string; balance: string }> {
  requirePermission(ctx, "inventory.stock.adjust");
  const data = parseInput(adjustStockInput, input);
  const type =
    data.direction === "IN"
      ? "ADJUSTMENT_IN"
      : data.kind === "WRITE_OFF"
        ? "WRITE_OFF"
        : ("ADJUSTMENT_OUT" as const);
  return tenantQuery(ctx, async (scope) => {
    const item = await loadItem(scope, data.inventoryItemId, { forStock: true });
    if (item.trackLots) requirePermission(ctx, "inventory.lot.manage");
    const loc = await loadLocation(scope, ctx, data.locationId);
    const lot = await loadMovementLot(scope, ctx, item, loc.id, data.stockLotId, "stockLotId");
    await lockStock(scope, [{ itemId: item.id, locationId: loc.id }]);
    const before = await usableSnapshot(scope, [{ itemId: item.id, locationId: loc.id }]);
    if (data.direction === "OUT") {
      const have = lot ? await lotMilli(scope, lot.id) : await balanceMilli(scope, item.id, loc.id);
      if (have < toMilli(data.quantity)) throw new AppError("INSUFFICIENT_STOCK");
    }
    const [m] = await scope.tx
      .insert(stockMovements)
      .values({
        tenantId: scope.tenantId,
        inventoryItemId: item.id,
        movementType: type,
        fromLocationId: data.direction === "OUT" ? loc.id : null,
        toLocationId: data.direction === "IN" ? loc.id : null,
        fromStockLotId: data.direction === "OUT" ? (lot?.id ?? null) : null,
        toStockLotId: data.direction === "IN" ? (lot?.id ?? null) : null,
        quantity: data.quantity,
        reason: data.reason,
        createdByUserId: ctx.userId,
      })
      .returning({ id: stockMovements.id })
      .catch(mapMovementError);
    await stockAudit(
      scope,
      ctx,
      "STOCK_ADJUSTED",
      {
        itemId: item.id,
        locationId: loc.id,
        branchId: loc.branchId,
        quantity: data.quantity,
        movementType: type,
      },
      { lotId: lot?.id ?? null },
    );
    await emitStockAlerts(scope, before);
    return { movementId: m!.id, balance: fromMilli(await balanceMilli(scope, item.id, loc.id)) };
  });
}

/**
 * Transfer — TEK hareket (TRANSFER, from + to). Tetikleyici iki bakiyeyi aynı transaction'da günceller: biri
 * başarısızsa hiçbiri değişmez. Şubeler arası transfer ayrıca inventory.transfer.cross_branch ister.
 */
export async function transferStock(
  ctx: AuthContext,
  input: unknown,
): Promise<{ movementId: string; toStockLotId: string | null }> {
  requirePermission(ctx, "inventory.transfer");
  const data = parseInput(transferStockInput, input);
  if (data.fromLocationId === data.toLocationId) {
    throw new AppError("VALIDATION", { fields: ["toLocationId"], message: "Kaynak ve hedef aynı olamaz." });
  }
  return tenantQuery(ctx, async (scope) => {
    const item = await loadItem(scope, data.inventoryItemId, { forStock: true });
    if (item.trackLots) requirePermission(ctx, "inventory.lot.manage");
    const from = await loadLocation(scope, ctx, data.fromLocationId);
    const crossAllowed = hasPermission(ctx, "inventory.transfer.cross_branch");
    const to = await loadLocation(scope, ctx, data.toLocationId, {
      requireActive: true,
      anyBranch: crossAllowed,
    });
    if (from.branchId !== to.branchId && !crossAllowed) throw new AppError("FORBIDDEN");
    const srcLot = await loadMovementLot(scope, ctx, item, from.id, data.fromStockLotId, "fromStockLotId");
    // Kilit sırası: lot kimliği → stok (geri çağırma ile aynı sıra; hedef lot satırı bu kilit altında açılır).
    if (srcLot) await lockLotIdentity(scope, item.id, srcLot.lotNumber);
    await lockStock(scope, [
      { itemId: item.id, locationId: from.id },
      { itemId: item.id, locationId: to.id },
    ]);
    // Kaynak lokasyonda kullanılabilir stok düşer → eşik geçişi kontrolü.
    const before = await usableSnapshot(scope, [{ itemId: item.id, locationId: from.id }]);
    let dstLot: { lot: LotRow; created: boolean } | null = null;
    if (srcLot) {
      // Kilit altında yeniden oku: geri çağırma bu işlemden hemen önce tamamlanmış olabilir.
      const [fresh] = await scope.tx
        .select({ recalledAt: stockLots.recalledAt, active: stockLots.active, q: stockLots.quantity })
        .from(stockLots)
        .where(tenantWhere(stockLots, scope, eq(stockLots.id, srcLot.id)));
      if (!fresh) throw new AppError("NOT_FOUND");
      if (fresh.recalledAt) throw new AppError("LOT_RECALLED");
      if (toMilli(fresh.q) < toMilli(data.quantity)) throw new AppError("INSUFFICIENT_STOCK");
      // Hedefte AYNI lot kimliği (numara + SKT) — tetikleyici de doğrular.
      dstLot = await findOrCreateLot(scope, {
        itemId: item.id,
        locationId: to.id,
        lotNumber: srcLot.lotNumber,
        expiryDate: srcLot.expiryDate,
        receivedAt: srcLot.receivedAt,
        supplierReference: srcLot.supplierReference,
      });
    } else if ((await balanceMilli(scope, item.id, from.id)) < toMilli(data.quantity)) {
      throw new AppError("INSUFFICIENT_STOCK");
    }
    const [m] = await scope.tx
      .insert(stockMovements)
      .values({
        tenantId: scope.tenantId,
        inventoryItemId: item.id,
        movementType: "TRANSFER",
        fromLocationId: from.id,
        toLocationId: to.id,
        fromStockLotId: srcLot?.id ?? null,
        toStockLotId: dstLot?.lot.id ?? null,
        quantity: data.quantity,
        reason: data.reason ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: stockMovements.id })
      .catch(mapMovementError);
    if (srcLot && dstLot) {
      if (dstLot.created) {
        await lotAudit(scope, ctx, "LOT_CREATED", dstLot.lot, to.branchId, { sourceLotId: srcLot.id });
      }
      await lotAudit(scope, ctx, "LOT_TRANSFERRED", srcLot, from.branchId, {
        toLotId: dstLot.lot.id,
        toLocationId: to.id,
        quantity: data.quantity,
      });
    }
    await stockAudit(
      scope,
      ctx,
      "STOCK_TRANSFERRED",
      {
        itemId: item.id,
        locationId: from.id,
        branchId: from.branchId,
        quantity: data.quantity,
        movementType: "TRANSFER",
      },
      { toLocationId: to.id, toBranchId: to.branchId, crossBranch: from.branchId !== to.branchId },
    );
    await emitStockAlerts(scope, before);
    return { movementId: m!.id, toStockLotId: dstLot?.lot.id ?? null };
  });
}

export type MovementListItem = {
  id: string;
  createdAt: Date;
  movementType: string;
  itemId: string;
  itemName: string;
  unit: string;
  quantity: string;
  fromLocationName: string | null;
  toLocationName: string | null;
  userName: string | null;
  reference: string | null;
  reason: string | null;
  patientUsageId: string | null;
  /** Lot takipli hareket: lot numarası (kaynak veya hedef lot). */
  lotNumber: string | null;
  lotExpiryDate: string | null;
};

/** Hareket geçmişi — sayfalı (25 / en fazla 100), kapsam: kaynağı veya hedefi görünür lokasyonda olan hareketler. */
export async function listStockMovements(ctx: AuthContext, input: unknown = {}) {
  requirePermission(ctx, "inventory.read");
  const data = parseInput(listMovementsInput, input);
  const fromLoc = alias(inventoryLocations, "from_loc");
  const toLoc = alias(inventoryLocations, "to_loc");
  const mvLot = alias(stockLots, "mv_lot");
  return tenantQuery(ctx, async (scope) => {
    const [p] = await scope.tx
      .select({ tz: clinicProfiles.timezone })
      .from(clinicProfiles)
      .where(tenantWhere(clinicProfiles, scope));
    const tz = p?.tz ?? DEFAULT_TIMEZONE;
    const scopeCond = ctx.branchScope.all
      ? undefined
      : or(locationScope(ctx, fromLoc.branchId), locationScope(ctx, toLoc.branchId));
    const conds: (SQL | undefined)[] = [
      scopeCond,
      data.inventoryItemId ? eq(stockMovements.inventoryItemId, data.inventoryItemId) : undefined,
      data.movementType ? eq(stockMovements.movementType, data.movementType) : undefined,
      data.locationId
        ? or(
            eq(stockMovements.fromLocationId, data.locationId),
            eq(stockMovements.toLocationId, data.locationId),
          )
        : undefined,
      data.branchId ? or(eq(fromLoc.branchId, data.branchId), eq(toLoc.branchId, data.branchId)) : undefined,
      data.stockLotId
        ? or(
            eq(stockMovements.fromStockLotId, data.stockLotId),
            eq(stockMovements.toStockLotId, data.stockLotId),
          )
        : undefined,
      data.from ? gte(stockMovements.createdAt, zonedDateTimeToUtc(data.from, 0, tz)) : undefined,
      data.to ? lt(stockMovements.createdAt, zonedDateTimeToUtc(addDays(data.to, 1), 0, tz)) : undefined,
    ];
    const base = () =>
      scope.tx
        .select({
          id: stockMovements.id,
          createdAt: stockMovements.createdAt,
          movementType: stockMovements.movementType,
          itemId: inventoryItems.id,
          itemName: inventoryItems.name,
          unit: inventoryItems.unit,
          quantity: stockMovements.quantity,
          fromLocationName: fromLoc.name,
          toLocationName: toLoc.name,
          userFirst: users.firstName,
          userLast: users.lastName,
          reference: stockMovements.reference,
          reason: stockMovements.reason,
          patientUsageId: stockMovements.patientUsageId,
          lotNumber: mvLot.lotNumber,
          lotExpiryDate: mvLot.expiryDate,
        })
        .from(stockMovements)
        .innerJoin(
          inventoryItems,
          and(
            eq(inventoryItems.id, stockMovements.inventoryItemId),
            eq(inventoryItems.tenantId, stockMovements.tenantId),
          ),
        )
        .leftJoin(
          fromLoc,
          and(eq(fromLoc.id, stockMovements.fromLocationId), eq(fromLoc.tenantId, stockMovements.tenantId)),
        )
        .leftJoin(
          toLoc,
          and(eq(toLoc.id, stockMovements.toLocationId), eq(toLoc.tenantId, stockMovements.tenantId)),
        )
        .leftJoin(
          users,
          and(eq(users.id, stockMovements.createdByUserId), eq(users.tenantId, stockMovements.tenantId)),
        )
        .leftJoin(
          mvLot,
          and(
            eq(mvLot.tenantId, stockMovements.tenantId),
            sql`${mvLot.id} = coalesce(${stockMovements.fromStockLotId}, ${stockMovements.toStockLotId})`,
          ),
        );
    const where = tenantWhere(stockMovements, scope, ...conds);
    const [{ n }] = (await scope.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(stockMovements)
      .leftJoin(
        fromLoc,
        and(eq(fromLoc.id, stockMovements.fromLocationId), eq(fromLoc.tenantId, stockMovements.tenantId)),
      )
      .leftJoin(
        toLoc,
        and(eq(toLoc.id, stockMovements.toLocationId), eq(toLoc.tenantId, stockMovements.tenantId)),
      )
      .where(where)) as [{ n: number }];
    const rows = await base()
      .where(where)
      .orderBy(desc(stockMovements.createdAt))
      .limit(data.limit)
      .offset((data.page - 1) * data.limit);
    const canUsage = hasPermission(ctx, "inventory.usage.read");
    const items: MovementListItem[] = rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      movementType: r.movementType,
      itemId: r.itemId,
      itemName: r.itemName,
      unit: r.unit,
      quantity: r.quantity,
      fromLocationName: r.fromLocationName,
      toLocationName: r.toLocationName,
      userName: r.userFirst ? `${r.userFirst} ${r.userLast}` : null,
      reference: r.reference,
      reason: r.reason,
      patientUsageId: canUsage ? r.patientUsageId : null,
      lotNumber: r.lotNumber,
      lotExpiryDate: r.lotExpiryDate,
    }));
    return { items, total: n, page: data.page, limit: data.limit };
  });
}

// ---------------------------------------------------------------- kritik stok + panel

export type LowStockRow = StockByLocationRow;

/**
 * Kritik stok: ürün düzeyinde asgari seviye (minimumStockLevel) ile LOKASYONDAKİ KULLANILABİLİR stok karşılaştırılır
 * (usable <= minimum). Ayrıca görünür lokasyonlarda kullanılabilir toplamı 0 olan (tükenen) aktif ürünler.
 * Lot takipli üründe SKT'si geçmiş / geri çağrılmış / pasif lotlar fiziksel stoktur ama kullanılabilir değildir.
 */
export async function getLowStockItems(ctx: AuthContext, input: unknown = {}) {
  requirePermission(ctx, "inventory.low_stock.read");
  const data = parseInput(getInventoryInput, input);
  return tenantQuery(ctx, async (scope) => {
    const low = await stockRows(scope, ctx, [
      eq(inventoryItems.active, true),
      eq(inventoryItems.trackInventory, true),
      sql`${inventoryItems.minimumStockLevel} is not null and ${balanceUsable()} <= ${inventoryItems.minimumStockLevel}`,
      data.branchId ? eq(inventoryLocations.branchId, data.branchId) : undefined,
      data.locationId ? eq(inventoryLocations.id, data.locationId) : undefined,
      data.categoryId ? eq(inventoryItems.categoryId, data.categoryId) : undefined,
    ]);
    // Tükenen: KULLANILABİLİR toplam 0 (yalnızca SKT'si geçmiş / geri çağrılmış lotu kalan ürün de tükenmiştir).
    const total = totalStockExpr(ctx, { usable: true });
    const out = await scope.tx
      .select({ id: inventoryItems.id, name: inventoryItems.name, unit: inventoryItems.unit })
      .from(inventoryItems)
      .where(
        tenantWhere(
          inventoryItems,
          scope,
          eq(inventoryItems.active, true),
          eq(inventoryItems.trackInventory, true),
          data.categoryId ? eq(inventoryItems.categoryId, data.categoryId) : undefined,
          sql`${total} = 0`,
        ),
      )
      .orderBy(asc(inventoryItems.name));
    await writeAudit(scope, actorOf(ctx), {
      action: "LOW_STOCK_VIEWED",
      entityType: "inventory",
      entityId: null,
      metadata: { lowCount: low.length, outOfStockCount: out.length, branchId: data.branchId ?? null },
    });
    return { low, outOfStock: out };
  });
}

/** /inventory panel kartları (kapsam içi). */
export async function getInventoryDashboard(ctx: AuthContext, input: unknown = {}) {
  requirePermission(ctx, "inventory.read");
  const data = parseInput(getInventoryInput, input);
  const canLow = hasPermission(ctx, "inventory.low_stock.read");
  const lowData = canLow ? await getLowStockItems(ctx, data) : { low: [], outOfStock: [] };
  return tenantQuery(ctx, async (scope) => {
    const [p] = await scope.tx
      .select({ tz: clinicProfiles.timezone })
      .from(clinicProfiles)
      .where(tenantWhere(clinicProfiles, scope));
    const tz = p?.tz ?? DEFAULT_TIMEZONE;
    const today = dateInZone(new Date(), tz);
    const start = zonedDateTimeToUtc(today, 0, tz);
    const [{ active }] = (await scope.tx
      .select({ active: sql<number>`count(*)::int` })
      .from(inventoryItems)
      .where(tenantWhere(inventoryItems, scope, eq(inventoryItems.active, true)))) as [{ active: number }];
    const fromLoc = alias(inventoryLocations, "f");
    const toLoc = alias(inventoryLocations, "t");
    const scoped = (col: PgColumn) =>
      and(locationScope(ctx, col) ?? sql`true`, data.branchId ? eq(col, data.branchId) : sql`true`);
    const counts = await scope.tx
      .select({
        usage: sql<number>`count(*) filter (where ${stockMovements.movementType} = 'PATIENT_USAGE')::int`,
        transfers: sql<number>`count(*) filter (where ${stockMovements.movementType} = 'TRANSFER')::int`,
      })
      .from(stockMovements)
      .leftJoin(
        fromLoc,
        and(eq(fromLoc.id, stockMovements.fromLocationId), eq(fromLoc.tenantId, stockMovements.tenantId)),
      )
      .leftJoin(
        toLoc,
        and(eq(toLoc.id, stockMovements.toLocationId), eq(toLoc.tenantId, stockMovements.tenantId)),
      )
      .where(
        tenantWhere(
          stockMovements,
          scope,
          gte(stockMovements.createdAt, start),
          or(
            and(sql`${fromLoc.id} is not null`, scoped(fromLoc.branchId)),
            and(sql`${toLoc.id} is not null`, scoped(toLoc.branchId)),
          ),
          data.locationId
            ? or(
                eq(stockMovements.fromLocationId, data.locationId),
                eq(stockMovements.toLocationId, data.locationId),
              )
            : undefined,
        ),
      );
    // Lot / SKT kartları (inventory.expiry.read). Şube yerel takvimi ile; geri çağrılmış lotlar hariç (ayrı süreç).
    let lotCards: { expiringSoon: number; expired: number; lotTrackedItems: number } | null = null;
    if (hasPermission(ctx, "inventory.expiry.read")) {
      const [cp] = await scope.tx
        .select({ days: clinicProfiles.expiryWarningDays })
        .from(clinicProfiles)
        .where(tenantWhere(clinicProfiles, scope));
      const days = cp?.days ?? 30;
      const localToday = sql`(now() at time zone ${branches.timezone})::date`;
      const [c] = await scope.tx
        .select({
          expired: sql<number>`count(*) filter (where ${stockLots.expiryDate} < ${localToday})::int`,
          expiringSoon: sql<number>`count(*) filter (where ${stockLots.expiryDate} >= ${localToday} and ${stockLots.expiryDate} <= ${localToday} + ${days}::int)::int`,
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
          and(
            eq(branches.id, inventoryLocations.branchId),
            eq(branches.tenantId, inventoryLocations.tenantId),
          ),
        )
        .where(
          tenantWhere(
            stockLots,
            scope,
            locationScope(ctx),
            sql`${stockLots.quantity} > 0`,
            sql`${stockLots.recalledAt} is null`,
            data.branchId ? eq(inventoryLocations.branchId, data.branchId) : undefined,
            data.locationId ? eq(inventoryLocations.id, data.locationId) : undefined,
          ),
        );
      const [t] = await scope.tx
        .select({ n: sql<number>`count(*)::int` })
        .from(inventoryItems)
        .where(
          tenantWhere(
            inventoryItems,
            scope,
            eq(inventoryItems.active, true),
            eq(inventoryItems.trackLots, true),
          ),
        );
      lotCards = { expiringSoon: c?.expiringSoon ?? 0, expired: c?.expired ?? 0, lotTrackedItems: t?.n ?? 0 };
    }
    return {
      today,
      activeItems: active,
      lotCards,
      lowStock: lowData.low.length,
      outOfStock: lowData.outOfStock.length,
      todayUsage: counts[0]?.usage ?? 0,
      todayTransfers: counts[0]?.transfers ?? 0,
      low: lowData.low,
      outOfStockItems: lowData.outOfStock,
    };
  });
}

// ---------------------------------------------------------------- uzlaştırma

/** Defter toplamı (kaynak gerçek) ile bakiye önbelleğini karşılaştırır. Fark varsa STOCK_BALANCE_MISMATCH audit. */
export async function verifyStockBalance(ctx: AuthContext, input: unknown) {
  requirePermission(ctx, "inventory.reconcile");
  const data = parseInput(reconcileInput, input);
  return tenantQuery(ctx, async (scope) => {
    const loc = await loadLocation(scope, ctx, data.locationId);
    const item = await loadItem(scope, data.inventoryItemId);
    const [l] = await scope.tx
      .select({
        sum: sql<string>`coalesce(sum(case when ${stockMovements.toLocationId} = ${loc.id} then ${stockMovements.quantity} else -${stockMovements.quantity} end), 0)`,
      })
      .from(stockMovements)
      .where(
        tenantWhere(
          stockMovements,
          scope,
          eq(stockMovements.inventoryItemId, item.id),
          or(eq(stockMovements.toLocationId, loc.id), eq(stockMovements.fromLocationId, loc.id)),
        ),
      );
    const expected = toMilli(l?.sum ?? 0);
    const actual = await balanceMilli(scope, item.id, loc.id);
    // Lot takipli: her lot önbelleği kendi defter toplamıyla; lot toplamı lokasyon bakiyesiyle eşleşmeli.
    const lots: { lotId: string; lotNumber: string; expected: string; actual: string; ok: boolean }[] = [];
    if (item.trackLots) {
      const rows = await scope.tx.execute<{
        id: string;
        lot_number: string;
        actual: string;
        ledger: string;
      }>(sql`
        select l.id, l.lot_number, l.quantity as actual,
          coalesce((select sum(case when m.to_stock_lot_id = l.id then m.quantity else -m.quantity end)
             from kliniva.stock_movements m
            where m.tenant_id = l.tenant_id and (m.to_stock_lot_id = l.id or m.from_stock_lot_id = l.id)), 0) as ledger
          from kliniva.stock_lots l
         where l.tenant_id = ${scope.tenantId}::uuid and l.inventory_item_id = ${item.id}::uuid
           and l.location_id = ${loc.id}::uuid
         order by l.lot_number`);
      for (const r of rows.rows) {
        lots.push({
          lotId: r.id,
          lotNumber: r.lot_number,
          expected: fromMilli(toMilli(r.ledger)),
          actual: fromMilli(toMilli(r.actual)),
          ok: toMilli(r.ledger) === toMilli(r.actual),
        });
      }
    }
    const lotSumMilli = lots.reduce((a, x) => a + toMilli(x.actual), 0);
    const lotsOk = !item.trackLots || (lots.every((x) => x.ok) && lotSumMilli === actual);
    const result = {
      itemId: item.id,
      locationId: loc.id,
      expected: fromMilli(expected),
      actual: fromMilli(actual),
      difference: fromMilli(actual - expected),
      lots,
      lotsOk,
      ok: expected === actual && lotsOk,
    };
    if (!result.ok) {
      await writeAudit(scope, actorOf(ctx), {
        action: "STOCK_BALANCE_MISMATCH",
        entityType: "inventory_item",
        entityId: item.id,
        branchId: loc.branchId,
        metadata: {
          itemId: item.id,
          locationId: loc.id,
          expected: result.expected,
          actual: result.actual,
          lotDiffs: lots.filter((x) => !x.ok).length,
        },
      });
    }
    return result;
  });
}

/**
 * Uzlaştırma — önce kuru çalıştırma (beklenen / gerçek / fark). apply=true ise bakiye ÖNBELLEĞİ defterden yeniden
 * hesaplanır; defter (kaynak gerçek) DEĞİŞMEZ, işlem audit'lenir. Fiziksel sayım farkı ise adjustStock ile
 * (ADJUSTMENT hareketi) düzeltilir — bakiye önbelleği için hareket eklemek defteri yanlışlıkla ikiye katlardı.
 */
export async function reconcileStockBalance(ctx: AuthContext, input: unknown) {
  const data = parseInput(reconcileInput, input);
  const check = await verifyStockBalance(ctx, data);
  if (!data.apply || check.ok) return { ...check, applied: false };
  return tenantQuery(ctx, async (scope) => {
    await lockStock(scope, [{ itemId: check.itemId, locationId: check.locationId }]);
    await scope.tx.execute(
      sql`select * from kliniva.recompute_stock_balance(${check.itemId}::uuid, ${check.locationId}::uuid)`,
    );
    for (const lot of check.lots.filter((x) => !x.ok)) {
      await scope.tx.execute(sql`select * from kliniva.recompute_stock_lot(${lot.lotId}::uuid)`);
    }
    await writeAudit(scope, actorOf(ctx), {
      action: "STOCK_BALANCE_RECONCILED",
      entityType: "inventory_item",
      entityId: check.itemId,
      metadata: {
        itemId: check.itemId,
        locationId: check.locationId,
        previous: check.actual,
        recomputed: check.expected,
      },
    });
    return { ...check, applied: true };
  });
}
