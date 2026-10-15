import "server-only";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  branches,
  clinicProfiles,
  inventoryCategories,
  inventoryItems,
  inventoryLocations,
  patientMaterialUsageAllocations,
  patientMaterialUsageItems,
  patientMaterialUsages,
  patients,
  stockLots,
  stockMovements,
} from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import {
  actorOf,
  canAccessBranch,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "@/server/auth/authz";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { encryptField } from "@/server/security/crypto";
import { patientScopeFilter } from "@/server/services/patients";
import {
  balanceMilli,
  loadItem,
  loadLocation,
  locationScope,
  lockStock,
  mapMovementError,
} from "@/server/services/inventory";
import { loadLotInScope, lockLotIdentity, locationToday, lotCandidates } from "@/server/services/lot-core";
import {
  correctLotInput,
  findLotTraceInput,
  fromMilli,
  getExpiringLotsInput,
  getStockByLotInput,
  physicalCountInput,
  recallLotInput,
  selectFefoInput,
  toMilli,
  writeOffLotInput,
} from "@/server/inventory/contracts";
import {
  daysBetween,
  fefoAllocate,
  fefoOrder,
  isExpired,
  lotStatus,
  type LotStatus,
} from "@/server/inventory/fefo";
import { addDays } from "@/lib/time";
import { emitStockAlerts, usableSnapshot } from "@/server/services/stock-alerts";
import { enqueueOutbox } from "@/server/notifications/outbox";

/**
 * Lot / SKT servisleri — HTTP / AI bağımsız. Her çağrı: yetki + kiracı (RLS) + şube kapsamı (lot lokasyonunun şubesi;
 * kapsam dışı lot → NOT_FOUND).
 *
 * SKT ANLAMI: lot, bulunduğu şubenin yerel takviminde SKT gününün SONUNA kadar geçerlidir ("bugün" her zaman sunucuda,
 * şubenin IANA saat dilimiyle hesaplanır — bkz. src/server/inventory/fefo.ts ve kliniva.lot_expired()).
 * LOT KİMLİĞİ: ürün + lot numarası. Transfer hedefte aynı numara + SKT ile ayrı satır açar; geri çağırma ve SKT
 * düzeltmesi kimliğin TÜM satırlarına uygulanır, hasta izleme tüm satırları kapsar.
 * Geri çağırma gerekçesi AES-256-GCM ile şifrelenir ve audit'e YAZILMAZ; audit'te hasta adı / kimliği yer almaz.
 */

const recallAad = (tenantId: string, lotId: string) => `stock_lot.recall_reason:${tenantId}:${lotId}`;

export type LotView = {
  id: string;
  inventoryItemId: string;
  itemName: string;
  unit: string;
  lotNumber: string;
  expiryDate: string | null;
  quantity: string;
  receivedAt: Date | null;
  supplierReference: string | null;
  active: boolean;
  recalled: boolean;
  recalledAt: Date | null;
  locationId: string;
  locationName: string;
  branchId: string;
  branchName: string;
  /** Şubenin yerel bugünü. */
  today: string;
  /** SKT'ye kalan gün (negatif = geçmiş); SKT yoksa null. */
  daysRemaining: number | null;
  status: LotStatus;
  usable: boolean;
};

async function warningDays(scope: TenantScope): Promise<number> {
  const [p] = await scope.tx
    .select({ d: clinicProfiles.expiryWarningDays })
    .from(clinicProfiles)
    .where(tenantWhere(clinicProfiles, scope));
  return p?.d ?? 30;
}

/** Lot satırları + türetilmiş durum (tek sorgu; şube yerel bugünü SQL'de hesaplanır). */
async function lotRows(
  scope: TenantScope,
  ctx: AuthContext,
  conds: (SQL | undefined)[],
  warnDays: number,
): Promise<LotView[]> {
  const rows = await scope.tx
    .select({
      lot: stockLots,
      itemName: inventoryItems.name,
      unit: inventoryItems.unit,
      minimum: inventoryItems.minimumStockLevel,
      locationName: inventoryLocations.name,
      branchId: branches.id,
      branchName: branches.name,
      today: sql<string>`((now() at time zone ${branches.timezone})::date)::text`,
    })
    .from(stockLots)
    .innerJoin(
      inventoryItems,
      and(eq(inventoryItems.id, stockLots.inventoryItemId), eq(inventoryItems.tenantId, stockLots.tenantId)),
    )
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
    .where(tenantWhere(stockLots, scope, locationScope(ctx), ...conds))
    .orderBy(sql`${stockLots.expiryDate} asc nulls last`, asc(inventoryItems.name), asc(stockLots.lotNumber))
    .limit(500);
  return rows.map((r) => {
    const quantityMilli = toMilli(r.lot.quantity);
    const cand = {
      active: r.lot.active,
      recalled: r.lot.recalledAt !== null,
      quantityMilli,
      expiryDate: r.lot.expiryDate,
    };
    return {
      id: r.lot.id,
      inventoryItemId: r.lot.inventoryItemId,
      itemName: r.itemName,
      unit: r.unit,
      lotNumber: r.lot.lotNumber,
      expiryDate: r.lot.expiryDate,
      quantity: r.lot.quantity,
      receivedAt: r.lot.receivedAt,
      supplierReference: r.lot.supplierReference,
      active: r.lot.active,
      recalled: cand.recalled,
      recalledAt: r.lot.recalledAt,
      locationId: r.lot.locationId,
      locationName: r.locationName,
      branchId: r.branchId,
      branchName: r.branchName,
      today: r.today,
      daysRemaining: r.lot.expiryDate ? daysBetween(r.today, r.lot.expiryDate) : null,
      status: lotStatus(
        cand,
        r.today,
        addDays(r.today, warnDays),
        r.minimum !== null ? toMilli(r.minimum) : null,
      ),
      usable: cand.active && !cand.recalled && quantityMilli > 0 && !isExpired(r.lot.expiryDate, r.today),
    };
  });
}

/** Lot bazında stok (ürün / lokasyon / şube filtresi). Boş (tükenmiş) lotlar yalnızca includeEmpty ile. */
export async function getStockByLot(ctx: AuthContext, input: unknown = {}): Promise<LotView[]> {
  requirePermission(ctx, "inventory.lot.read");
  const data = parseInput(getStockByLotInput, input);
  return tenantQuery(ctx, async (scope) =>
    lotRows(
      scope,
      ctx,
      [
        data.inventoryItemId ? eq(stockLots.inventoryItemId, data.inventoryItemId) : undefined,
        data.locationId ? eq(stockLots.locationId, data.locationId) : undefined,
        data.branchId ? eq(inventoryLocations.branchId, data.branchId) : undefined,
        data.includeEmpty ? undefined : sql`${stockLots.quantity} > 0`,
      ],
      await warningDays(scope),
    ),
  );
}

/** Lot detayı (kapsam dışı → NOT_FOUND). */
export async function getLot(ctx: AuthContext, rawId: unknown) {
  requirePermission(ctx, "inventory.lot.read");
  return tenantQuery(ctx, async (scope) => {
    const lot = await loadLotInScope(scope, ctx, rawId);
    const [view] = await lotRows(scope, ctx, [eq(stockLots.id, lot.id)], await warningDays(scope));
    if (!view) throw new AppError("NOT_FOUND");
    // Aynı lot kimliğinin diğer lokasyonlardaki (görünür) satırları.
    const siblings = await lotRows(
      scope,
      ctx,
      [
        eq(stockLots.inventoryItemId, lot.inventoryItemId),
        eq(stockLots.lotNumber, lot.lotNumber),
        sql`${stockLots.id} <> ${lot.id}`,
      ],
      await warningDays(scope),
    );
    const [item] = await scope.tx
      .select({ trackExpiry: inventoryItems.trackExpiry })
      .from(inventoryItems)
      .where(tenantWhere(inventoryItems, scope, eq(inventoryItems.id, lot.inventoryItemId)));
    return { ...view, trackExpiry: item?.trackExpiry ?? false, siblings };
  });
}

/**
 * SKT raporu. kind=expiring: bugün ≤ SKT ≤ bugün + gün (geri çağrılmamış, miktarı > 0);
 * kind=expired: SKT < bugün ve miktarı > 0 (fiziksel stok — imha / iade bekleyen). Gün boşsa klinik ayarı.
 */
export async function getExpiringLots(ctx: AuthContext, input: unknown = {}) {
  requirePermission(ctx, "inventory.expiry.read");
  const data = parseInput(getExpiringLotsInput, input);
  return tenantQuery(ctx, async (scope) => {
    const days = data.days ?? (await warningDays(scope));
    const localToday = sql`(now() at time zone ${branches.timezone})::date`;
    const rows = await lotRows(
      scope,
      ctx,
      [
        sql`${stockLots.quantity} > 0`,
        sql`${stockLots.expiryDate} is not null`,
        data.kind === "expired"
          ? sql`${stockLots.expiryDate} < ${localToday}`
          : and(
              sql`${stockLots.recalledAt} is null`,
              sql`${stockLots.expiryDate} >= ${localToday}`,
              sql`${stockLots.expiryDate} <= ${localToday} + ${days}::int`,
            ),
        data.branchId ? eq(inventoryLocations.branchId, data.branchId) : undefined,
        data.locationId ? eq(stockLots.locationId, data.locationId) : undefined,
        data.categoryId ? eq(inventoryItems.categoryId, data.categoryId) : undefined,
      ],
      days,
    );
    await writeAudit(scope, actorOf(ctx), {
      action: "LOT_EXPIRY_VIEWED",
      entityType: "inventory",
      entityId: null,
      branchId: data.branchId ?? null,
      metadata: { kind: data.kind, days, found: rows.length, branchId: data.branchId ?? null },
    });
    return { kind: data.kind, days, rows };
  });
}

/** Rapor filtreleri için kategoriler (UI yardımcı). */
export async function listExpiryFilterCategories(ctx: AuthContext) {
  requirePermission(ctx, "inventory.expiry.read");
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select({ id: inventoryCategories.id, name: inventoryCategories.name })
      .from(inventoryCategories)
      .where(tenantWhere(inventoryCategories, scope, eq(inventoryCategories.active, true)))
      .orderBy(asc(inventoryCategories.name)),
  );
}

/**
 * FEFO önerisi (stok DÜŞMEZ). Kullanılabilir lotlar FEFO sırasıyla + tahsis; yetersizse shortfall > 0.
 * Hasta kullanımı kesinleştirmesi aynı saf fonksiyonu kilit altında yeniden çalıştırır.
 */
export async function selectFefoLots(ctx: AuthContext, input: unknown) {
  requirePermission(ctx, "inventory.lot.read");
  const data = parseInput(selectFefoInput, input);
  return tenantQuery(ctx, async (scope) => {
    const item = await loadItem(scope, data.inventoryItemId);
    const loc = await loadLocation(scope, ctx, data.locationId);
    if (!item.trackLots)
      throw new AppError("VALIDATION", { fields: ["inventoryItemId"], message: "Ürün lot takipli değil." });
    const { today } = await locationToday(scope, loc.id);
    const cands = await lotCandidates(scope, item.id, loc.id);
    const res = fefoAllocate(cands, toMilli(data.quantity), today);
    return {
      today,
      allocations: res.allocations.map((a) => ({ ...a, quantity: fromMilli(a.quantityMilli) })),
      shortfall: fromMilli(res.shortfallMilli),
      usableLots: fefoOrder(cands, today).map((c) => ({
        id: c.id,
        lotNumber: c.lotNumber,
        expiryDate: c.expiryDate,
        quantity: fromMilli(c.quantityMilli),
      })),
    };
  });
}

// ---------------------------------------------------------------- geri çağırma / düzeltme

/** Kimliğin (ürün + numara) tüm satırları + kilitleri: kimlik kilidi → lokasyon stok kilitleri (sabit sıra). */
async function lockIdentityRows(scope: TenantScope, lot: { inventoryItemId: string; lotNumber: string }) {
  await lockLotIdentity(scope, lot.inventoryItemId, lot.lotNumber);
  const rows = await scope.tx
    .select()
    .from(stockLots)
    .where(
      tenantWhere(
        stockLots,
        scope,
        eq(stockLots.inventoryItemId, lot.inventoryItemId),
        eq(stockLots.lotNumber, lot.lotNumber),
      ),
    );
  // Kimlik kilidi altında yeni satır açılamaz → bu liste kesindir. Stok kilitleri kullanım / transferle serileştirir.
  await lockStock(
    scope,
    rows.map((r) => ({ itemId: r.inventoryItemId, locationId: r.locationId })),
  );
  return rows;
}

/**
 * Geri çağırma — GERİ ALINAMAZ. Lot kimliğinin TÜM lokasyonlardaki satırları işaretlenir; yeni hasta kullanımı ve
 * transfer reddedilir (LOT_RECALLED), geçmiş kullanım / hareketler DEĞİŞMEZ. Fiziksel stok imha / iade (write-off)
 * ile düşülür. Gerekçe zorunlu, şifreli; audit'e yazılmaz.
 */
export async function recallLot(ctx: AuthContext, input: unknown): Promise<{ affectedLots: number }> {
  requirePermission(ctx, "inventory.lot.recall");
  // Geri çağırma kiracı genelidir (lot kimliğinin TÜM şubelerdeki satırları) → şube kapsamlı kullanıcı yapamaz,
  // izin özel bir rolle verilmiş olsa bile.
  if (!ctx.branchScope.all) throw new AppError("FORBIDDEN");
  const data = parseInput(recallLotInput, input);
  return tenantQuery(ctx, async (scope) => {
    const lot = await loadLotInScope(scope, ctx, data.stockLotId);
    const rows = await lockIdentityRows(scope, lot);
    if (rows.some((r) => r.recalledAt !== null)) {
      throw new AppError("CONFLICT", { message: "Lot zaten geri çağrılmış (geri çağırma geri alınamaz)." });
    }
    const before = await usableSnapshot(
      scope,
      rows.map((r) => ({ itemId: r.inventoryItemId, locationId: r.locationId })),
    );
    const now = new Date();
    for (const r of rows) {
      await scope.tx
        .update(stockLots)
        .set({
          recalledAt: now,
          recalledByUserId: ctx.userId,
          recallReasonEncrypted: encryptField(data.reason, recallAad(scope.tenantId, r.id)),
          updatedAt: now,
        })
        .where(tenantWhere(stockLots, scope, eq(stockLots.id, r.id)));
    }
    await writeAudit(scope, actorOf(ctx), {
      action: "LOT_RECALLED",
      entityType: "stock_lot",
      entityId: lot.id,
      branchId: lot.branchId,
      metadata: { lotId: lot.id, itemId: lot.inventoryItemId, affectedLots: rows.length },
    });
    // Bildirim: gerekçe YOK — yalnızca lot / ürün / etkilenen şube kimlikleri.
    const branchIds = [
      ...new Set(before.size ? [...before.values()].map((b) => b.branchId) : [lot.branchId]),
    ];
    await enqueueOutbox(scope, {
      eventType: "LOT_RECALLED",
      aggregateType: "stock_lot",
      aggregateId: lot.id,
      payload: {
        lotId: lot.id,
        itemId: lot.inventoryItemId,
        branchIds: branchIds.join(","),
        affectedLots: rows.length,
      },
      deduplicationKey: `lot-recalled:${lot.inventoryItemId}:${lot.lotNumber}`,
    });
    await emitStockAlerts(scope, before);
    return { affectedLots: rows.length };
  });
}

/**
 * SKT düzeltmesi (yüksek yetki). Lot numarası DEĞİŞMEZ. Kimliğin tüm satırları birlikte düzeltilir (transfer kimlik
 * eşitliği korunur). Geri çağrılmış lot düzeltilemez. Önceki / yeni SKT audit'e yazılır (gerekçe yazılmaz).
 */
export async function correctLotMetadata(ctx: AuthContext, input: unknown): Promise<void> {
  requirePermission(ctx, "inventory.lot.correct_metadata");
  const data = parseInput(correctLotInput, input);
  await tenantQuery(ctx, async (scope) => {
    const lot = await loadLotInScope(scope, ctx, data.stockLotId);
    const rows = await lockIdentityRows(scope, lot);
    if (rows.some((r) => r.recalledAt !== null)) throw new AppError("LOT_RECALLED");
    if (lot.expiryDate === data.expiryDate) return;
    const now = new Date();
    for (const r of rows) {
      await scope.tx
        .update(stockLots)
        .set({ expiryDate: data.expiryDate, updatedAt: now })
        .where(tenantWhere(stockLots, scope, eq(stockLots.id, r.id)));
    }
    await writeAudit(scope, actorOf(ctx), {
      action: "LOT_METADATA_CORRECTED",
      entityType: "stock_lot",
      entityId: lot.id,
      branchId: lot.branchId,
      metadata: {
        lotId: lot.id,
        itemId: lot.inventoryItemId,
        field: "expiryDate",
        previous: lot.expiryDate,
        next: data.expiryDate,
        affectedLots: rows.length,
      },
    });
  });
}

// ---------------------------------------------------------------- imha / sayım

/**
 * SKT geçmiş (veya geri çağrılmış) lot stoğunun imhası: WRITE_OFF hareketi (defter; silme yok). Gerekçe zorunlu.
 * Kullanılabilir lotun fire kaydı genel düzeltme (adjustStock WRITE_OFF) ile yapılır.
 */
export async function writeOffLot(
  ctx: AuthContext,
  input: unknown,
): Promise<{ movementId: string; remaining: string }> {
  requirePermission(ctx, "inventory.write_off");
  const data = parseInput(writeOffLotInput, input);
  return tenantQuery(ctx, async (scope) => {
    const lot = await loadLotInScope(scope, ctx, data.stockLotId);
    await lockStock(scope, [{ itemId: lot.inventoryItemId, locationId: lot.locationId }]);
    const before = await usableSnapshot(scope, [{ itemId: lot.inventoryItemId, locationId: lot.locationId }]);
    const { today } = await locationToday(scope, lot.locationId);
    const [fresh] = await scope.tx
      .select()
      .from(stockLots)
      .where(tenantWhere(stockLots, scope, eq(stockLots.id, lot.id)));
    if (!fresh) throw new AppError("NOT_FOUND");
    const expired = isExpired(fresh.expiryDate, today);
    if (!expired && !fresh.recalledAt) {
      throw new AppError("VALIDATION", {
        fields: ["stockLotId"],
        message:
          "Yalnızca SKT'si geçmiş veya geri çağrılmış lot imha edilir; diğer fireler stok düzeltmesiyle girilir.",
      });
    }
    const have = toMilli(fresh.quantity);
    const qtyMilli = data.quantity ? toMilli(data.quantity) : have;
    if (qtyMilli <= 0 || qtyMilli > have) throw new AppError("INSUFFICIENT_STOCK");
    const quantity = fromMilli(qtyMilli);
    const [m] = await scope.tx
      .insert(stockMovements)
      .values({
        tenantId: scope.tenantId,
        inventoryItemId: lot.inventoryItemId,
        movementType: "WRITE_OFF",
        fromLocationId: lot.locationId,
        fromStockLotId: lot.id,
        quantity,
        reason: data.reason,
        createdByUserId: ctx.userId,
      })
      .returning({ id: stockMovements.id })
      .catch(mapMovementError);
    await writeAudit(scope, actorOf(ctx), {
      action: "EXPIRED_STOCK_WRITTEN_OFF",
      entityType: "stock_lot",
      entityId: lot.id,
      branchId: lot.branchId,
      metadata: {
        lotId: lot.id,
        itemId: lot.inventoryItemId,
        locationId: lot.locationId,
        quantity,
        expired,
        recalled: fresh.recalledAt !== null,
      },
    });
    await emitStockAlerts(scope, before);
    return { movementId: m!.id, remaining: fromMilli(have - qtyMilli) };
  });
}

/**
 * Fiziksel sayım: beklenen (defter önbelleği) ile sayılan karşılaştırılır. apply=false → yalnızca fark (kayıt yok);
 * apply=true (kullanıcı onayı) → fark varsa ADJUSTMENT_IN / ADJUSTMENT_OUT hareketi + PHYSICAL_COUNT_RECORDED.
 * Lot takipli üründe sayım lot bazındadır (stockLotId zorunlu).
 */
export async function recordPhysicalCount(ctx: AuthContext, input: unknown) {
  requirePermission(ctx, "inventory.physical_count");
  const data = parseInput(physicalCountInput, input);
  return tenantQuery(ctx, async (scope) => {
    const item = await loadItem(scope, data.inventoryItemId, { forStock: true });
    const loc = await loadLocation(scope, ctx, data.locationId);
    let lotId: string | null = null;
    if (item.trackLots) {
      if (!data.stockLotId)
        throw new AppError("VALIDATION", { fields: ["stockLotId"], message: "Lot seçimi zorunlu." });
      const lot = await loadLotInScope(scope, ctx, data.stockLotId);
      if (lot.inventoryItemId !== item.id || lot.locationId !== loc.id) throw new AppError("NOT_FOUND");
      lotId = lot.id;
    } else if (data.stockLotId) {
      throw new AppError("VALIDATION", { fields: ["stockLotId"], message: "Bu ürün lot takipli değil." });
    }
    await lockStock(scope, [{ itemId: item.id, locationId: loc.id }]);
    const before = await usableSnapshot(scope, [{ itemId: item.id, locationId: loc.id }]);
    const expectedMilli = lotId
      ? toMilli(
          (
            await scope.tx
              .select({ q: stockLots.quantity })
              .from(stockLots)
              .where(tenantWhere(stockLots, scope, eq(stockLots.id, lotId)))
          )[0]?.q ?? 0,
        )
      : await balanceMilli(scope, item.id, loc.id);
    const countedMilli = toMilli(data.countedQuantity);
    const diff = countedMilli - expectedMilli;
    const result = {
      itemId: item.id,
      locationId: loc.id,
      stockLotId: lotId,
      expected: fromMilli(expectedMilli),
      counted: fromMilli(countedMilli),
      difference: (diff < 0 ? "-" : "") + fromMilli(Math.abs(diff)),
      applied: false,
      movementId: null as string | null,
    };
    if (!data.apply) return result;
    if (diff !== 0) {
      const inbound = diff > 0;
      const [m] = await scope.tx
        .insert(stockMovements)
        .values({
          tenantId: scope.tenantId,
          inventoryItemId: item.id,
          movementType: inbound ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
          fromLocationId: inbound ? null : loc.id,
          toLocationId: inbound ? loc.id : null,
          fromStockLotId: inbound ? null : lotId,
          toStockLotId: inbound ? lotId : null,
          quantity: fromMilli(Math.abs(diff)),
          reason: data.reason ?? "Fiziksel sayım farkı",
          reference: "PHYSICAL_COUNT",
          createdByUserId: ctx.userId,
        })
        .returning({ id: stockMovements.id })
        .catch(mapMovementError);
      result.movementId = m!.id;
    }
    result.applied = true;
    await writeAudit(scope, actorOf(ctx), {
      action: "PHYSICAL_COUNT_RECORDED",
      entityType: "inventory_item",
      entityId: item.id,
      branchId: loc.branchId,
      metadata: {
        itemId: item.id,
        locationId: loc.id,
        lotId,
        expected: result.expected,
        counted: result.counted,
        adjusted: diff !== 0,
      },
    });
    await emitStockAlerts(scope, before);
    return result;
  });
}

// ---------------------------------------------------------------- hasta izleme (geri çağırma temeli)

export type LotTraceRow = {
  patientId: string;
  patientNumber: string;
  patientUsageId: string;
  usageStatus: "DRAFT" | "FINALIZED" | "VOIDED";
  finalizedAt: Date | null;
  branchName: string;
  locationName: string;
  lotNumber: string;
  quantity: string;
};

/**
 * Lotun kullanıldığı hastalar — YALNIZCA kimlik düzeyi (hasta kimliği + dosya numarası; ad / iletişim YOK).
 * Lot kimliğinin tüm satırları; kesinleşmiş ve sonradan geçersiz kılınmış kullanımlar (durumu ile). Kapsam:
 * kullanımın şubesi + hastanın görünürlüğü. Audit: lot + sonuç sayısı (hasta kimlikleri YAZILMAZ).
 */
export async function findPatientsByLot(ctx: AuthContext, input: unknown): Promise<{ rows: LotTraceRow[] }> {
  requirePermission(ctx, "inventory.lot.trace");
  const data = parseInput(findLotTraceInput, input);
  return tenantQuery(ctx, async (scope) => {
    const lot = await loadLotInScope(scope, ctx, data.stockLotId);
    const identity = await scope.tx
      .select({ id: stockLots.id })
      .from(stockLots)
      .where(
        tenantWhere(
          stockLots,
          scope,
          eq(stockLots.inventoryItemId, lot.inventoryItemId),
          eq(stockLots.lotNumber, lot.lotNumber),
        ),
      );
    const branchScope = ctx.branchScope.all
      ? undefined
      : ctx.branchScope.branchIds.size
        ? inArray(patientMaterialUsages.branchId, [...ctx.branchScope.branchIds])
        : sql`false`;
    const rows = await scope.tx
      .select({
        patientId: patients.id,
        patientNumber: patients.patientNumber,
        patientUsageId: patientMaterialUsages.id,
        usageStatus: patientMaterialUsages.status,
        finalizedAt: patientMaterialUsages.finalizedAt,
        branchName: branches.name,
        locationName: inventoryLocations.name,
        lotNumber: stockLots.lotNumber,
        quantity: patientMaterialUsageAllocations.quantity,
      })
      .from(patientMaterialUsageAllocations)
      .innerJoin(
        patientMaterialUsageItems,
        and(
          eq(patientMaterialUsageItems.id, patientMaterialUsageAllocations.patientUsageItemId),
          eq(patientMaterialUsageItems.tenantId, patientMaterialUsageAllocations.tenantId),
        ),
      )
      .innerJoin(
        patientMaterialUsages,
        and(
          eq(patientMaterialUsages.id, patientMaterialUsageItems.patientUsageId),
          eq(patientMaterialUsages.tenantId, patientMaterialUsageItems.tenantId),
        ),
      )
      .innerJoin(
        patients,
        and(
          eq(patients.id, patientMaterialUsages.patientId),
          eq(patients.tenantId, patientMaterialUsages.tenantId),
        ),
      )
      .innerJoin(
        branches,
        and(
          eq(branches.id, patientMaterialUsages.branchId),
          eq(branches.tenantId, patientMaterialUsages.tenantId),
        ),
      )
      .innerJoin(
        stockLots,
        and(
          eq(stockLots.id, patientMaterialUsageAllocations.stockLotId),
          eq(stockLots.tenantId, patientMaterialUsageAllocations.tenantId),
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
          patientMaterialUsageAllocations,
          scope,
          inArray(
            patientMaterialUsageAllocations.stockLotId,
            identity.map((r) => r.id),
          ),
          // Taslaktaki elle seçim kullanım değildir.
          sql`${patientMaterialUsages.status} <> 'DRAFT'`,
          branchScope,
          patientScopeFilter(ctx),
        ),
      )
      .orderBy(asc(patientMaterialUsages.finalizedAt));
    await writeAudit(scope, actorOf(ctx), {
      action: "LOT_PATIENT_TRACE_VIEWED",
      entityType: "stock_lot",
      entityId: lot.id,
      branchId: lot.branchId,
      metadata: { lotId: lot.id, itemId: lot.inventoryItemId, found: rows.length },
    });
    return { rows };
  });
}

/** UI yardımcı: kullanıcının bu lot üzerindeki yetkileri. */
export function lotCapabilities(ctx: AuthContext, branchId: string) {
  const visible = canAccessBranch(ctx, branchId);
  return {
    recall: visible && ctx.branchScope.all && hasPermission(ctx, "inventory.lot.recall"),
    correct: visible && hasPermission(ctx, "inventory.lot.correct_metadata"),
    trace: visible && hasPermission(ctx, "inventory.lot.trace"),
    writeOff: visible && hasPermission(ctx, "inventory.write_off"),
    count: visible && hasPermission(ctx, "inventory.physical_count"),
  };
}
