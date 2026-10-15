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

export async function loadItem(scope: TenantScope, rawId: unknown, opts: { forStock?: boolean } = {}) {
  const id = parseId(rawId);
  const [item] = await scope.tx
    .select()
    .from(inventoryItems)
    .where(tenantWhere(inventoryItems, scope, eq(inventoryItems.id, id)));
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
    if (item.trackLots) {
      // Lot bazlı hareket Sprint 5 kapsamında (model temeli hazır).
      throw new AppError("VALIDATION", {
        fields: ["inventoryItemId"],
        message: "Lot takipli ürün hareketleri henüz desteklenmiyor.",
      });
    }
  }
  return item;
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
  /** Kullanıcının görebildiği lokasyonlardaki toplam. */
  totalStock: string;
  lowStock: boolean;
};

/** Görünür lokasyonlardaki toplam stok (tek alt sorgu — N+1 yok). */
function totalStockExpr(ctx: AuthContext) {
  const scoped = ctx.branchScope.all
    ? sql``
    : sql` and l.branch_id in (${sql.join(
        [...ctx.branchScope.branchIds].map((b) => sql`${b}::uuid`),
        sql`, `,
      )})`;
  if (!ctx.branchScope.all && ctx.branchScope.branchIds.size === 0) return sql<string>`0::numeric`;
  return sql<string>`(select coalesce(sum(b.quantity), 0) from kliniva.stock_balances b
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
        active: inventoryItems.active,
        totalStock: total,
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
        lowStock: r.minimumStockLevel !== null && toMilli(r.totalStock) <= toMilli(r.minimumStockLevel),
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
    const before = await loadItem(scope, id);
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
      metadata: { itemId: id, active: data.active },
    });
  });
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
  quantity: string;
  minimumStockLevel: string | null;
};

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
    return {
      ...item,
      categoryName: cat?.name ?? null,
      stockByLocation: stock,
      totalStock: fromMilli(totalMilli),
      lowStock: item.minimumStockLevel !== null && totalMilli <= toMilli(item.minimumStockLevel),
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
): Promise<{ movementId: string; balance: string }> {
  requirePermission(ctx, "inventory.stock.add");
  const data = parseInput(addStockInput, input);
  return tenantQuery(ctx, async (scope) => {
    const item = await loadItem(scope, data.inventoryItemId, { forStock: true });
    const loc = await loadLocation(scope, ctx, data.locationId, { requireActive: true });
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
    const [m] = await scope.tx
      .insert(stockMovements)
      .values({
        tenantId: scope.tenantId,
        inventoryItemId: item.id,
        movementType: data.kind,
        toLocationId: loc.id,
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
    return { movementId: m!.id, balance: fromMilli(await balanceMilli(scope, item.id, loc.id)) };
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
    const loc = await loadLocation(scope, ctx, data.locationId);
    await lockStock(scope, [{ itemId: item.id, locationId: loc.id }]);
    if (data.direction === "OUT" && (await balanceMilli(scope, item.id, loc.id)) < toMilli(data.quantity)) {
      throw new AppError("INSUFFICIENT_STOCK");
    }
    const [m] = await scope.tx
      .insert(stockMovements)
      .values({
        tenantId: scope.tenantId,
        inventoryItemId: item.id,
        movementType: type,
        fromLocationId: data.direction === "OUT" ? loc.id : null,
        toLocationId: data.direction === "IN" ? loc.id : null,
        quantity: data.quantity,
        reason: data.reason,
        createdByUserId: ctx.userId,
      })
      .returning({ id: stockMovements.id })
      .catch(mapMovementError);
    await stockAudit(scope, ctx, "STOCK_ADJUSTED", {
      itemId: item.id,
      locationId: loc.id,
      branchId: loc.branchId,
      quantity: data.quantity,
      movementType: type,
    });
    return { movementId: m!.id, balance: fromMilli(await balanceMilli(scope, item.id, loc.id)) };
  });
}

/**
 * Transfer — TEK hareket (TRANSFER, from + to). Tetikleyici iki bakiyeyi aynı transaction'da günceller: biri
 * başarısızsa hiçbiri değişmez. Şubeler arası transfer ayrıca inventory.transfer.cross_branch ister.
 */
export async function transferStock(ctx: AuthContext, input: unknown): Promise<{ movementId: string }> {
  requirePermission(ctx, "inventory.transfer");
  const data = parseInput(transferStockInput, input);
  if (data.fromLocationId === data.toLocationId) {
    throw new AppError("VALIDATION", { fields: ["toLocationId"], message: "Kaynak ve hedef aynı olamaz." });
  }
  return tenantQuery(ctx, async (scope) => {
    const item = await loadItem(scope, data.inventoryItemId, { forStock: true });
    const from = await loadLocation(scope, ctx, data.fromLocationId);
    const crossAllowed = hasPermission(ctx, "inventory.transfer.cross_branch");
    const to = await loadLocation(scope, ctx, data.toLocationId, {
      requireActive: true,
      anyBranch: crossAllowed,
    });
    if (from.branchId !== to.branchId && !crossAllowed) throw new AppError("FORBIDDEN");
    await lockStock(scope, [
      { itemId: item.id, locationId: from.id },
      { itemId: item.id, locationId: to.id },
    ]);
    if ((await balanceMilli(scope, item.id, from.id)) < toMilli(data.quantity))
      throw new AppError("INSUFFICIENT_STOCK");
    const [m] = await scope.tx
      .insert(stockMovements)
      .values({
        tenantId: scope.tenantId,
        inventoryItemId: item.id,
        movementType: "TRANSFER",
        fromLocationId: from.id,
        toLocationId: to.id,
        quantity: data.quantity,
        reason: data.reason ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: stockMovements.id })
      .catch(mapMovementError);
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
    return { movementId: m!.id };
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
};

/** Hareket geçmişi — sayfalı (25 / en fazla 100), kapsam: kaynağı veya hedefi görünür lokasyonda olan hareketler. */
export async function listStockMovements(ctx: AuthContext, input: unknown = {}) {
  requirePermission(ctx, "inventory.read");
  const data = parseInput(listMovementsInput, input);
  const fromLoc = alias(inventoryLocations, "from_loc");
  const toLoc = alias(inventoryLocations, "to_loc");
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
    }));
    return { items, total: n, page: data.page, limit: data.limit };
  });
}

// ---------------------------------------------------------------- kritik stok + panel

export type LowStockRow = StockByLocationRow;

/**
 * Kritik stok: ürün düzeyinde asgari seviye (minimumStockLevel) ile LOKASYON bakiyesi karşılaştırılır
 * (quantity <= minimum). Ayrıca görünür lokasyonlarda toplam stoğu 0 olan (tükenen) aktif ürünler.
 */
export async function getLowStockItems(ctx: AuthContext, input: unknown = {}) {
  requirePermission(ctx, "inventory.low_stock.read");
  const data = parseInput(getInventoryInput, input);
  return tenantQuery(ctx, async (scope) => {
    const low = await stockRows(scope, ctx, [
      eq(inventoryItems.active, true),
      eq(inventoryItems.trackInventory, true),
      sql`${inventoryItems.minimumStockLevel} is not null and ${stockBalances.quantity} <= ${inventoryItems.minimumStockLevel}`,
      data.branchId ? eq(inventoryLocations.branchId, data.branchId) : undefined,
      data.locationId ? eq(inventoryLocations.id, data.locationId) : undefined,
      data.categoryId ? eq(inventoryItems.categoryId, data.categoryId) : undefined,
    ]);
    const total = totalStockExpr(ctx);
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
    return {
      today,
      activeItems: active,
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
    const result = {
      itemId: item.id,
      locationId: loc.id,
      expected: fromMilli(expected),
      actual: fromMilli(actual),
      difference: fromMilli(actual - expected),
      ok: expected === actual,
    };
    if (!result.ok) {
      await writeAudit(scope, actorOf(ctx), {
        action: "STOCK_BALANCE_MISMATCH",
        entityType: "inventory_item",
        entityId: item.id,
        branchId: loc.branchId,
        metadata: { itemId: item.id, locationId: loc.id, expected: result.expected, actual: result.actual },
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

// ---------------------------------------------------------------- lot / son kullanma (temel)

/** Yaklaşan son kullanma tarihli lotlar (Sprint 5'te lot bazlı tüketim; şimdilik rapor temeli). */
export async function getExpiringLots(ctx: AuthContext, days = 30) {
  requirePermission(ctx, "inventory.read");
  const until = new Date(Date.now() + Math.min(Math.max(days, 1), 365) * 24 * 3600_000)
    .toISOString()
    .slice(0, 10);
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select({
        lotId: stockLots.id,
        itemName: inventoryItems.name,
        lotNumber: stockLots.lotNumber,
        expiryDate: stockLots.expiryDate,
        quantity: stockLots.quantity,
        locationName: inventoryLocations.name,
      })
      .from(stockLots)
      .innerJoin(
        inventoryItems,
        and(
          eq(inventoryItems.id, stockLots.inventoryItemId),
          eq(inventoryItems.tenantId, stockLots.tenantId),
        ),
      )
      .innerJoin(
        inventoryLocations,
        and(
          eq(inventoryLocations.id, stockLots.locationId),
          eq(inventoryLocations.tenantId, stockLots.tenantId),
        ),
      )
      .where(
        tenantWhere(
          stockLots,
          scope,
          locationScope(ctx),
          sql`${stockLots.expiryDate} <= ${until}::date`,
          sql`${stockLots.quantity} > 0`,
        ),
      )
      .orderBy(asc(stockLots.expiryDate)),
  );
}
