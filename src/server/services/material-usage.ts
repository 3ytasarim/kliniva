import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  appointments,
  branches,
  clinicalServices,
  doctorProfiles,
  inventoryItems,
  inventoryLocations,
  patientMaterialUsageAllocations,
  patientMaterialUsageItems,
  patientMaterialUsages,
  patients,
  rooms,
  serviceMaterialTemplates,
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
import { loadVisiblePatient } from "@/server/services/patients";
import { doctorDisplayName } from "@/server/services/doctors";
import { loadAccessibleAppointment, selfDoctorId } from "@/server/services/appointments";
import {
  balanceMilli,
  defaultLocationFor,
  loadItem,
  loadLocation,
  lockStock,
  mapMovementError,
  parseId,
} from "@/server/services/inventory";
import { decryptField, encryptField } from "@/server/security/crypto";
import {
  createUsageInput,
  fromMilli,
  recordMaterialUsageInput,
  templateInput,
  toMilli,
  usageAllocationInput,
  usageItemInput,
  voidInput,
} from "@/server/inventory/contracts";
import { lotCandidates, loadLotInScope, locationToday, usableLotSum } from "@/server/services/lot-core";
import { fefoAllocate, fefoOrder, isExpired, type LotAllocation } from "@/server/inventory/fefo";

/**
 * Hasta / randevu bazlı sarf kullanımı.
 *  DRAFT    → stok DÜŞMEZ; kalemler eklenir / değiştirilir (şablon yalnızca öneri olarak eklenir).
 *  FINALIZED→ tek transaction: tüm kalemler kilitlenir, hepsinde yeterli stok varsa PATIENT_USAGE hareketleri;
 *             biri bile yetersizse HİÇBİR stok düşmez (rollback). Sonrasında değişmez (DB tetikleyicisi).
 *  VOIDED   → orijinal hareketler silinmez; her biri için RETURN_FROM_PATIENT_USAGE ters hareketi. Gerekçe zorunlu.
 * Kapsam: şube (kullanımın şubesi) + doktorun kendi kapsamı (yalnızca kendi randevularına bağlı kullanım).
 * Not şifreli; audit'e hasta adı / not YAZILMAZ.
 */

const notesAad = (tenantId: string, id: string) => `material_usage.notes:${tenantId}:${id}`;

/** Yalnızca kendi randevularını gören doktor (appointment.read yok, appointment.read.own var). */
const isOwnScopeDoctor = (ctx: AuthContext) =>
  !hasPermission(ctx, "appointment.read") && hasPermission(ctx, "appointment.read.own");

async function usageVisibility(scope: TenantScope, ctx: AuthContext): Promise<SQL | undefined> {
  const conds: SQL[] = [];
  if (!ctx.branchScope.all) {
    const ids = [...ctx.branchScope.branchIds];
    conds.push(ids.length ? inArray(patientMaterialUsages.branchId, ids) : sql`false`);
  }
  if (isOwnScopeDoctor(ctx)) {
    const self = await selfDoctorId(scope, ctx);
    conds.push(self ? eq(patientMaterialUsages.doctorId, self) : sql`false`);
  }
  return conds.length ? and(...conds) : undefined;
}

async function loadUsage(
  scope: TenantScope,
  ctx: AuthContext,
  rawId: unknown,
  opts: { forUpdate?: boolean } = {},
) {
  const id = parseId(rawId);
  const q = scope.tx
    .select()
    .from(patientMaterialUsages)
    .where(
      tenantWhere(
        patientMaterialUsages,
        scope,
        eq(patientMaterialUsages.id, id),
        await usageVisibility(scope, ctx),
      ),
    );
  const [row] = opts.forUpdate ? await q.for("update") : await q;
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

async function usageAudit(
  scope: TenantScope,
  ctx: AuthContext,
  action: AuditAction,
  u: { id: string; branchId: string; appointmentId: string | null; status: string },
  extra: Record<string, string | number | boolean | null> = {},
) {
  await writeAudit(scope, actorOf(ctx), {
    action,
    entityType: "patient_material_usage",
    entityId: u.id,
    branchId: u.branchId,
    metadata: {
      patientUsageId: u.id,
      branchId: u.branchId,
      appointmentId: u.appointmentId,
      status: u.status,
      ...extra,
    },
  });
}

function requireDraft(u: { status: string }) {
  if (u.status !== "DRAFT") {
    throw new AppError("INVALID_STATUS_TRANSITION", {
      message: "Kesinleşmiş / geçersiz kullanım değiştirilemez.",
    });
  }
}

// ---------------------------------------------------------------- oluşturma (taslak)

async function createUsageInScope(scope: TenantScope, ctx: AuthContext, input: unknown) {
  const data = parseInput(createUsageInput, input);
  const patient = await loadVisiblePatient(scope, ctx, data.patientId);
  let branchId: string;
  let roomId: string | null = null;
  let doctorId: string | null = null;
  let appointmentId: string | null = null;
  let serviceId: string | null = null;

  if (data.appointmentId) {
    // Doktor yalnızca KENDİ randevusunu görür → başka doktorunki NOT_FOUND.
    const a = await loadAccessibleAppointment(scope, ctx, data.appointmentId);
    if (a.patientId !== patient.id) throw new AppError("NOT_FOUND");
    if (a.status === "CANCELLED" || a.status === "NO_SHOW") {
      throw new AppError("INVALID_STATUS_TRANSITION", {
        message: "İptal edilmiş / gelinmemiş randevuya kullanım eklenemez.",
      });
    }
    if (a.status !== "IN_PROGRESS" && a.status !== "COMPLETED") {
      throw new AppError("INVALID_STATUS_TRANSITION", {
        message: "Malzeme kullanımı işlemdeki veya tamamlanmış randevuya girilir.",
      });
    }
    branchId = a.branchId;
    roomId = a.roomId;
    doctorId = a.doctorId;
    appointmentId = a.id;
    serviceId = a.serviceId;
  } else {
    if (isOwnScopeDoctor(ctx)) {
      throw new AppError("VALIDATION", {
        fields: ["appointmentId"],
        message: "Doktor kullanımı kendi randevusuna bağlanmalıdır.",
      });
    }
    if (!data.branchId) throw new AppError("VALIDATION", { fields: ["branchId"] });
    branchId = data.branchId;
  }
  if (!canAccessBranch(ctx, branchId)) throw new AppError("NOT_FOUND");

  const id = randomUUID();
  await scope.tx.insert(patientMaterialUsages).values({
    id,
    tenantId: scope.tenantId,
    patientId: patient.id,
    appointmentId,
    branchId,
    roomId,
    doctorId,
    status: "DRAFT",
    notesEncrypted: data.notes ? encryptField(data.notes, notesAad(scope.tenantId, id)) : null,
    createdByUserId: ctx.userId,
  });

  // Hizmet şablonu: YALNIZCA öneri — taslağa eklenir, stok düşmez; kullanıcı miktarı değiştirir / siler.
  let suggested = 0;
  if (data.applyTemplate && serviceId) {
    const tpl = await scope.tx
      .select({
        itemId: serviceMaterialTemplates.inventoryItemId,
        qty: serviceMaterialTemplates.defaultQuantity,
      })
      .from(serviceMaterialTemplates)
      .innerJoin(
        inventoryItems,
        and(
          eq(inventoryItems.id, serviceMaterialTemplates.inventoryItemId),
          eq(inventoryItems.tenantId, serviceMaterialTemplates.tenantId),
        ),
      )
      .where(
        tenantWhere(
          serviceMaterialTemplates,
          scope,
          eq(serviceMaterialTemplates.clinicalServiceId, serviceId),
          eq(inventoryItems.active, true),
          eq(inventoryItems.trackInventory, true),
        ),
      );
    const loc = tpl.length ? await defaultLocationFor(scope, branchId, roomId) : null;
    if (loc) {
      for (const t of tpl) {
        await scope.tx.insert(patientMaterialUsageItems).values({
          tenantId: scope.tenantId,
          patientUsageId: id,
          inventoryItemId: t.itemId,
          locationId: loc,
          quantity: t.qty,
        });
        suggested++;
      }
    }
  }
  await usageAudit(
    scope,
    ctx,
    "PATIENT_MATERIAL_USAGE_CREATED",
    { id, branchId, appointmentId, status: "DRAFT" },
    {
      templateItems: suggested,
    },
  );
  return { id, branchId, appointmentId };
}

export async function createPatientMaterialUsage(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "inventory.usage.create");
  return tenantQuery(ctx, async (scope) => ({ id: (await createUsageInScope(scope, ctx, input)).id }));
}

async function upsertItemInScope(
  scope: TenantScope,
  ctx: AuthContext,
  usage: { id: string; branchId: string },
  input: unknown,
) {
  const data = parseInput(usageItemInput, input);
  const item = await loadItem(scope, data.inventoryItemId, { forStock: true });
  const loc = await loadLocation(scope, ctx, data.locationId, { requireActive: true });
  if (loc.branchId !== usage.branchId) {
    throw new AppError("VALIDATION", {
      fields: ["locationId"],
      message: "Stok kaynağı kullanımın şubesinde olmalı.",
    });
  }
  const [row] = await scope.tx
    .insert(patientMaterialUsageItems)
    .values({
      tenantId: scope.tenantId,
      patientUsageId: usage.id,
      inventoryItemId: item.id,
      locationId: loc.id,
      quantity: data.quantity,
    })
    .onConflictDoUpdate({
      target: [
        patientMaterialUsageItems.tenantId,
        patientMaterialUsageItems.patientUsageId,
        patientMaterialUsageItems.inventoryItemId,
        patientMaterialUsageItems.locationId,
      ],
      set: { quantity: data.quantity },
    })
    .returning({ id: patientMaterialUsageItems.id });
  // Miktar değişti → önceki elle lot seçimi geçersiz (kesinleştirmede yeniden FEFO veya yeni seçim).
  await scope.tx
    .delete(patientMaterialUsageAllocations)
    .where(
      tenantWhere(
        patientMaterialUsageAllocations,
        scope,
        eq(patientMaterialUsageAllocations.patientUsageItemId, row!.id),
      ),
    );
  return { id: row!.id, trackLots: item.trackLots };
}

/**
 * Taslak kalem için ELLE lot seçimi (FEFO'yu geçersiz kılar). Boş liste → seçim temizlenir (kesinleştirmede FEFO).
 * Taslakta stok DÜŞMEZ; seçim kesinleştirmede kilit altında yeniden doğrulanır. Burada da erken doğrulama yapılır:
 * lot aynı ürün + aynı lokasyonda olmalı (aksi NOT_FOUND), süresi geçmiş / geri çağrılmış / pasif / yetersiz lot
 * seçilemez, toplam kalemin miktarına eşit olmalı.
 */
async function setItemLotsInScope(
  scope: TenantScope,
  ctx: AuthContext,
  usage: { id: string },
  itemRowId: string,
  lots: { stockLotId: string; quantity: string }[],
) {
  const [line] = await scope.tx
    .select({
      id: patientMaterialUsageItems.id,
      itemId: patientMaterialUsageItems.inventoryItemId,
      locationId: patientMaterialUsageItems.locationId,
      quantity: patientMaterialUsageItems.quantity,
      trackLots: inventoryItems.trackLots,
    })
    .from(patientMaterialUsageItems)
    .innerJoin(
      inventoryItems,
      and(
        eq(inventoryItems.id, patientMaterialUsageItems.inventoryItemId),
        eq(inventoryItems.tenantId, patientMaterialUsageItems.tenantId),
      ),
    )
    .where(
      tenantWhere(
        patientMaterialUsageItems,
        scope,
        eq(patientMaterialUsageItems.id, itemRowId),
        eq(patientMaterialUsageItems.patientUsageId, usage.id),
      ),
    );
  if (!line) throw new AppError("NOT_FOUND");
  if (!line.trackLots && lots.length) {
    throw new AppError("VALIDATION", { fields: ["lots"], message: "Bu ürün lot takipli değil." });
  }
  await scope.tx
    .delete(patientMaterialUsageAllocations)
    .where(
      tenantWhere(
        patientMaterialUsageAllocations,
        scope,
        eq(patientMaterialUsageAllocations.patientUsageItemId, line.id),
      ),
    );
  if (!lots.length) return;
  const ids = lots.map((l) => l.stockLotId);
  if (new Set(ids).size !== ids.length) {
    throw new AppError("VALIDATION", { fields: ["lots"], message: "Aynı lot iki kez seçilemez." });
  }
  const total = lots.reduce((a, l) => a + toMilli(l.quantity), 0);
  if (total !== toMilli(line.quantity)) {
    throw new AppError("VALIDATION", {
      fields: ["lots"],
      message: "Lot miktarlarının toplamı kalem miktarına eşit olmalı.",
    });
  }
  const { today } = await locationToday(scope, line.locationId);
  for (const sel of lots) {
    const lot = await loadLotInScope(scope, ctx, sel.stockLotId);
    assertLotUsable(lot, line, today, toMilli(sel.quantity));
    await scope.tx.insert(patientMaterialUsageAllocations).values({
      tenantId: scope.tenantId,
      patientUsageItemId: line.id,
      inventoryItemId: line.itemId,
      locationId: line.locationId,
      stockLotId: lot.id,
      quantity: sel.quantity,
    });
  }
}

/** Hasta kullanımı için lot uygunluğu (servis kontrolü; DB tetikleyicisi aynı kuralları son savunma olarak uygular). */
function assertLotUsable(
  lot: {
    id: string;
    inventoryItemId: string;
    locationId: string;
    recalledAt: Date | null;
    active: boolean;
    expiryDate: string | null;
    quantity: string;
    lotNumber: string;
  },
  line: { itemId: string; locationId: string },
  today: string,
  needMilli: number,
) {
  if (lot.inventoryItemId !== line.itemId || lot.locationId !== line.locationId)
    throw new AppError("NOT_FOUND");
  if (lot.recalledAt) throw new AppError("LOT_RECALLED");
  if (!lot.active) throw new AppError("VALIDATION", { fields: ["lots"], message: "Lot aktif değil." });
  if (isExpired(lot.expiryDate, today)) throw new AppError("LOT_EXPIRED");
  if (toMilli(lot.quantity) < needMilli) {
    throw new AppError("INSUFFICIENT_STOCK", { message: `Lot ${lot.lotNumber} için yeterli stok yok.` });
  }
}

/** Taslak kalemin lot seçimini ayarlar (boş liste = otomatik FEFO). */
export async function setPatientMaterialUsageItemLots(
  ctx: AuthContext,
  rawUsageId: unknown,
  rawItemRowId: unknown,
  input: unknown,
): Promise<void> {
  requirePermission(ctx, "inventory.usage.create");
  requirePermission(ctx, "inventory.lot.read");
  const rowId = parseId(rawItemRowId);
  const data = parseInput(usageAllocationInput, input);
  await tenantQuery(ctx, async (scope) => {
    const u = await loadUsage(scope, ctx, rawUsageId, { forUpdate: true });
    requireDraft(u);
    await setItemLotsInScope(scope, ctx, u, rowId, data.lots);
  });
}

/** Taslağa kalem ekler / miktarını ayarlar (aynı ürün + lokasyon tek satır). */
export async function addPatientMaterialUsageItem(
  ctx: AuthContext,
  rawUsageId: unknown,
  input: unknown,
): Promise<void> {
  requirePermission(ctx, "inventory.usage.create");
  await tenantQuery(ctx, async (scope) => {
    const u = await loadUsage(scope, ctx, rawUsageId, { forUpdate: true });
    requireDraft(u);
    await upsertItemInScope(scope, ctx, u, input);
  });
}

export async function removePatientMaterialUsageItem(
  ctx: AuthContext,
  rawUsageId: unknown,
  rawItemRowId: unknown,
): Promise<void> {
  requirePermission(ctx, "inventory.usage.create");
  const rowId = parseId(rawItemRowId);
  await tenantQuery(ctx, async (scope) => {
    const u = await loadUsage(scope, ctx, rawUsageId, { forUpdate: true });
    requireDraft(u);
    // Önce elle lot seçimi (tahsis koruması taslak kalemi görürken çalışır; kaskada bırakılmaz).
    await scope.tx.delete(patientMaterialUsageAllocations).where(
      tenantWhere(
        patientMaterialUsageAllocations,
        scope,
        eq(patientMaterialUsageAllocations.patientUsageItemId, rowId),
        sql`exists (select 1 from kliniva.patient_material_usage_items i where i.tenant_id = ${scope.tenantId}::uuid
                and i.id = ${rowId}::uuid and i.patient_usage_id = ${u.id}::uuid)`,
      ),
    );
    await scope.tx
      .delete(patientMaterialUsageItems)
      .where(
        tenantWhere(
          patientMaterialUsageItems,
          scope,
          eq(patientMaterialUsageItems.id, rowId),
          eq(patientMaterialUsageItems.patientUsageId, u.id),
        ),
      );
  });
}

// ---------------------------------------------------------------- kesinleştirme / VOID

async function finalizeInScope(scope: TenantScope, ctx: AuthContext, rawId: unknown) {
  const u = await loadUsage(scope, ctx, rawId, { forUpdate: true });
  requireDraft(u);
  const items = await scope.tx
    .select({
      rowId: patientMaterialUsageItems.id,
      itemId: patientMaterialUsageItems.inventoryItemId,
      locationId: patientMaterialUsageItems.locationId,
      quantity: patientMaterialUsageItems.quantity,
      name: inventoryItems.name,
      active: inventoryItems.active,
      trackInventory: inventoryItems.trackInventory,
      trackLots: inventoryItems.trackLots,
      locationName: inventoryLocations.name,
    })
    .from(patientMaterialUsageItems)
    .innerJoin(
      inventoryItems,
      and(
        eq(inventoryItems.id, patientMaterialUsageItems.inventoryItemId),
        eq(inventoryItems.tenantId, patientMaterialUsageItems.tenantId),
      ),
    )
    .innerJoin(
      inventoryLocations,
      and(
        eq(inventoryLocations.id, patientMaterialUsageItems.locationId),
        eq(inventoryLocations.tenantId, patientMaterialUsageItems.tenantId),
      ),
    )
    .where(tenantWhere(patientMaterialUsageItems, scope, eq(patientMaterialUsageItems.patientUsageId, u.id)));
  if (!items.length)
    throw new AppError("VALIDATION", { fields: ["items"], message: "Kullanımda hiç malzeme yok." });

  // 1) Tüm kalemler deterministik sırada kilitlenir, 2) HEPSİ kontrol edilir (lot tahsisi dahil), 3) ancak sonra
  //    tahsisler + hareketler yazılır. Herhangi bir hata → transaction geri alınır, HİÇBİR stok düşmez.
  await lockStock(scope, items);
  const need = new Map<string, number>();
  for (const it of items)
    need.set(
      `${it.itemId}:${it.locationId}`,
      (need.get(`${it.itemId}:${it.locationId}`) ?? 0) + toMilli(it.quantity),
    );
  const plan = new Map<string, LotAllocation[]>();
  const todayByLocation = new Map<string, string>();
  for (const it of items) {
    if (!it.trackInventory) continue;
    if (it.trackLots) {
      // SKT günü sunucuda, lokasyonun şube saat dilimiyle (istemci tarihine güvenilmez).
      if (!todayByLocation.has(it.locationId)) {
        todayByLocation.set(it.locationId, (await locationToday(scope, it.locationId)).today);
      }
      plan.set(it.rowId, await allocateLine(scope, ctx, it, todayByLocation.get(it.locationId)!));
      continue;
    }
    const have = await balanceMilli(scope, it.itemId, it.locationId);
    if (have < need.get(`${it.itemId}:${it.locationId}`)!) {
      throw new AppError("INSUFFICIENT_STOCK", {
        message: `${it.name} için ${it.locationName} lokasyonunda yeterli stok yok (mevcut ${fromMilli(have).replace(/\.?0+$/, "")}).`,
      });
    }
  }
  let allocationCount = 0;
  const lotIds = new Set<string>();
  for (const it of items) {
    if (!it.trackInventory) continue;
    const base = {
      tenantId: scope.tenantId,
      inventoryItemId: it.itemId,
      movementType: "PATIENT_USAGE" as const,
      fromLocationId: it.locationId,
      patientId: u.patientId,
      appointmentId: u.appointmentId,
      patientUsageId: u.id,
      createdByUserId: ctx.userId,
    };
    const allocs = plan.get(it.rowId);
    if (!allocs) {
      await scope.tx
        .insert(stockMovements)
        .values({ ...base, quantity: it.quantity })
        .catch(mapMovementError);
      continue;
    }
    // Kesin tahsis: önceki elle seçim yerine gerçek tahsis yazılır (usage hâlâ DRAFT → tetikleyici izin verir).
    await scope.tx
      .delete(patientMaterialUsageAllocations)
      .where(
        tenantWhere(
          patientMaterialUsageAllocations,
          scope,
          eq(patientMaterialUsageAllocations.patientUsageItemId, it.rowId),
        ),
      );
    for (const a of allocs) {
      const qty = fromMilli(a.quantityMilli);
      await scope.tx.insert(patientMaterialUsageAllocations).values({
        tenantId: scope.tenantId,
        patientUsageItemId: it.rowId,
        inventoryItemId: it.itemId,
        locationId: it.locationId,
        stockLotId: a.lotId,
        quantity: qty,
      });
      await scope.tx
        .insert(stockMovements)
        .values({ ...base, quantity: qty, fromStockLotId: a.lotId })
        .catch(mapMovementError);
      allocationCount++;
      lotIds.add(a.lotId);
    }
  }
  const now = new Date();
  await scope.tx
    .update(patientMaterialUsages)
    .set({ status: "FINALIZED", finalizedAt: now, finalizedByUserId: ctx.userId, updatedAt: now })
    .where(tenantWhere(patientMaterialUsages, scope, eq(patientMaterialUsages.id, u.id)));
  await usageAudit(
    scope,
    ctx,
    "PATIENT_MATERIAL_USAGE_FINALIZED",
    { ...u, status: "FINALIZED" },
    { itemCount: items.length },
  );
  if (allocationCount) {
    // Lot izlenebilirliği: kullanım kimliği + sayılar. Hasta kimliği bu kayda YAZILMAZ.
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_LOT_USAGE_FINALIZED",
      entityType: "patient_material_usage",
      entityId: u.id,
      branchId: u.branchId,
      metadata: { patientUsageId: u.id, allocationCount, lots: lotIds.size },
    });
  }
  return u.id;
}

/**
 * Lot takipli kalemin tahsisi — KİLİT ALTINDA güncel lot verisiyle:
 *  - elle seçim varsa: her lot yeniden doğrulanır (SKT / geri çağırma / aktiflik / miktar) ve toplam = kalem miktarı;
 *  - yoksa otomatik FEFO (birden fazla lot kullanılabilir); kullanılabilir toplam yetmezse INSUFFICIENT_STOCK.
 */
async function allocateLine(
  scope: TenantScope,
  ctx: AuthContext,
  it: {
    rowId: string;
    itemId: string;
    locationId: string;
    quantity: string;
    name: string;
    locationName: string;
  },
  today: string,
): Promise<LotAllocation[]> {
  const needMilli = toMilli(it.quantity);
  const manual = await scope.tx
    .select({
      lotId: patientMaterialUsageAllocations.stockLotId,
      quantity: patientMaterialUsageAllocations.quantity,
    })
    .from(patientMaterialUsageAllocations)
    .where(
      tenantWhere(
        patientMaterialUsageAllocations,
        scope,
        eq(patientMaterialUsageAllocations.patientUsageItemId, it.rowId),
      ),
    );
  if (manual.length) {
    if (manual.reduce((a, m) => a + toMilli(m.quantity), 0) !== needMilli) {
      throw new AppError("VALIDATION", {
        fields: ["lots"],
        message: `${it.name}: lot seçimi kalem miktarıyla uyuşmuyor.`,
      });
    }
    const out: LotAllocation[] = [];
    for (const m of manual) {
      const lot = await loadLotInScope(scope, ctx, m.lotId);
      assertLotUsable(lot, it, today, toMilli(m.quantity));
      out.push({
        lotId: lot.id,
        lotNumber: lot.lotNumber,
        expiryDate: lot.expiryDate,
        quantityMilli: toMilli(m.quantity),
      });
    }
    return out;
  }
  const res = fefoAllocate(await lotCandidates(scope, it.itemId, it.locationId), needMilli, today);
  if (res.shortfallMilli > 0) {
    throw new AppError("INSUFFICIENT_STOCK", {
      message: `${it.name} için ${it.locationName} lokasyonunda kullanılabilir (SKT'si geçmemiş, geri çağrılmamış) lot stoğu yetersiz.`,
    });
  }
  return res.allocations;
}

export async function finalizePatientMaterialUsage(ctx: AuthContext, rawId: unknown): Promise<void> {
  requirePermission(ctx, "inventory.usage.finalize");
  await tenantQuery(ctx, (scope) => finalizeInScope(scope, ctx, rawId));
}

/**
 * VOID — orijinal PATIENT_USAGE hareketleri SİLİNMEZ; her biri için ters RETURN_FROM_PATIENT_USAGE eklenir
 * (stok aynı lokasyona geri döner). Taslak VOID'lenebilir (stok hareketi olmadan). İkinci VOID reddedilir.
 */
export async function voidPatientMaterialUsage(
  ctx: AuthContext,
  rawId: unknown,
  input: unknown,
): Promise<void> {
  requirePermission(ctx, "inventory.usage.void");
  const data = parseInput(voidInput, input);
  await tenantQuery(ctx, async (scope) => {
    const u = await loadUsage(scope, ctx, rawId, { forUpdate: true });
    if (u.status === "VOIDED")
      throw new AppError("INVALID_STATUS_TRANSITION", { message: "Kullanım zaten geçersiz." });
    let reversed = 0;
    if (u.status === "FINALIZED") {
      const moves = await scope.tx
        .select()
        .from(stockMovements)
        .where(
          tenantWhere(
            stockMovements,
            scope,
            eq(stockMovements.patientUsageId, u.id),
            eq(stockMovements.movementType, "PATIENT_USAGE"),
          ),
        );
      await lockStock(
        scope,
        moves.map((m) => ({ itemId: m.inventoryItemId, locationId: m.fromLocationId! })),
      );
      for (const m of moves) {
        await scope.tx
          .insert(stockMovements)
          .values({
            tenantId: scope.tenantId,
            inventoryItemId: m.inventoryItemId,
            movementType: "RETURN_FROM_PATIENT_USAGE",
            toLocationId: m.fromLocationId,
            // Lot takipli: stok AYNI lota döner (geri çağrılmış / süresi geçmiş olsa bile — fiziksel iade).
            toStockLotId: m.fromStockLotId,
            quantity: m.quantity,
            patientId: m.patientId,
            appointmentId: m.appointmentId,
            patientUsageId: u.id,
            reference: m.id,
            reason: "VOID",
            createdByUserId: ctx.userId,
          })
          .catch(mapMovementError);
        reversed++;
      }
    }
    const now = new Date();
    await scope.tx
      .update(patientMaterialUsages)
      .set({
        status: "VOIDED",
        voidedAt: now,
        voidedByUserId: ctx.userId,
        voidReason: data.reason,
        updatedAt: now,
      })
      .where(tenantWhere(patientMaterialUsages, scope, eq(patientMaterialUsages.id, u.id)));
    // Gerekçe serbest metindir → audit'e YAZILMAZ.
    await usageAudit(
      scope,
      ctx,
      "PATIENT_MATERIAL_USAGE_VOIDED",
      { ...u, status: "VOIDED" },
      { reversedMovements: reversed },
    );
  });
}

/** Voice AI'ye hazır tek adım: taslak + kalemler (+ isteğe bağlı kesinleştirme) — hepsi tek transaction. */
export async function recordMaterialUsage(
  ctx: AuthContext,
  input: unknown,
): Promise<{ id: string; finalized: boolean }> {
  requirePermission(ctx, "inventory.usage.create");
  const data = parseInput(recordMaterialUsageInput, input);
  if (data.finalize) requirePermission(ctx, "inventory.usage.finalize");
  return tenantQuery(ctx, async (scope) => {
    const u = await createUsageInScope(scope, ctx, { ...data, applyTemplate: false });
    for (const it of data.items) {
      const locationId =
        it.locationId ?? (await defaultLocationFor(scope, u.branchId, await roomOf(scope, u.id)));
      if (!locationId) throw new AppError("VALIDATION", { fields: ["locationId"] });
      const line = await upsertItemInScope(scope, ctx, u, {
        inventoryItemId: it.inventoryItemId,
        quantity: it.quantity,
        locationId,
      });
      // Elle lot seçimi (yoksa kesinleştirmede FEFO).
      if (it.lots?.length) {
        requirePermission(ctx, "inventory.lot.read");
        await setItemLotsInScope(scope, ctx, u, line.id, it.lots);
      }
    }
    if (data.finalize) await finalizeInScope(scope, ctx, u.id);
    return { id: u.id, finalized: data.finalize };
  });
}

async function roomOf(scope: TenantScope, usageId: string) {
  const [r] = await scope.tx
    .select({ roomId: patientMaterialUsages.roomId })
    .from(patientMaterialUsages)
    .where(tenantWhere(patientMaterialUsages, scope, eq(patientMaterialUsages.id, usageId)));
  return r?.roomId ?? null;
}

// ---------------------------------------------------------------- okuma

export type UsageItemView = {
  id: string;
  inventoryItemId: string;
  itemName: string;
  unit: string;
  locationId: string;
  locationName: string;
  quantity: string;
  /** Kullanılabilir stok (lot takipli üründe SKT geçmiş / geri çağrılmış lotlar hariç). */
  available: string;
  trackLots: boolean;
  /** Kesinleşmiş tahsis veya taslaktaki elle seçim. */
  allocations: UsageLotLine[];
  /** Taslakta elle seçim yoksa: otomatik FEFO önerisi (stok düşmez; kesinleştirmede yeniden hesaplanır). */
  suggested: UsageLotLine[];
  /** Elle seçim için kullanılabilir lotlar (FEFO sırasında). */
  lotOptions: (UsageLotLine & { available: string })[];
  /** Taslak: öneri karşılanamıyor (kullanılabilir lot stoğu yetersiz). */
  shortfall: boolean;
};

export type UsageLotLine = {
  stockLotId: string;
  lotNumber: string;
  expiryDate: string | null;
  quantity: string;
};

export type UsageListItem = {
  id: string;
  status: "DRAFT" | "FINALIZED" | "VOIDED";
  createdAt: Date;
  finalizedAt: Date | null;
  appointmentId: string | null;
  appointmentStart: Date | null;
  branchName: string;
  roomName: string | null;
  doctorName: string | null;
  patient: { id: string; name: string; patientNumber: string };
  items: {
    itemName: string;
    unit: string;
    quantity: string;
    /** Hasta izlenebilirliği: kullanılan lot numaraları (yalnızca inventory.lot.read). */
    lots: { lotNumber: string; expiryDate: string | null; quantity: string }[];
  }[];
};

/** Kalem satırlarının tahsisleri (lot numarasıyla). */
async function allocationsFor(scope: TenantScope, rowIds: string[]) {
  if (!rowIds.length) return [];
  return scope.tx
    .select({
      rowId: patientMaterialUsageAllocations.patientUsageItemId,
      stockLotId: stockLots.id,
      lotNumber: stockLots.lotNumber,
      expiryDate: stockLots.expiryDate,
      quantity: patientMaterialUsageAllocations.quantity,
    })
    .from(patientMaterialUsageAllocations)
    .innerJoin(
      stockLots,
      and(
        eq(stockLots.id, patientMaterialUsageAllocations.stockLotId),
        eq(stockLots.tenantId, patientMaterialUsageAllocations.tenantId),
      ),
    )
    .where(
      tenantWhere(
        patientMaterialUsageAllocations,
        scope,
        inArray(patientMaterialUsageAllocations.patientUsageItemId, rowIds),
      ),
    )
    .orderBy(asc(stockLots.expiryDate), asc(stockLots.lotNumber));
}

async function listUsagesInScope(
  scope: TenantScope,
  ctx: AuthContext,
  conds: (SQL | undefined)[],
): Promise<UsageListItem[]> {
  const rows = await scope.tx
    .select({
      id: patientMaterialUsages.id,
      status: patientMaterialUsages.status,
      createdAt: patientMaterialUsages.createdAt,
      finalizedAt: patientMaterialUsages.finalizedAt,
      appointmentId: patientMaterialUsages.appointmentId,
      appointmentStart: appointments.scheduledStart,
      branchName: branches.name,
      roomName: rooms.name,
      doctorTitle: doctorProfiles.title,
      doctorFirst: users.firstName,
      doctorLast: users.lastName,
      patientId: patients.id,
      patientFirst: patients.firstName,
      patientLast: patients.lastName,
      patientNumber: patients.patientNumber,
    })
    .from(patientMaterialUsages)
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
    .leftJoin(
      rooms,
      and(eq(rooms.id, patientMaterialUsages.roomId), eq(rooms.tenantId, patientMaterialUsages.tenantId)),
    )
    .leftJoin(
      appointments,
      and(
        eq(appointments.id, patientMaterialUsages.appointmentId),
        eq(appointments.tenantId, patientMaterialUsages.tenantId),
      ),
    )
    .leftJoin(
      doctorProfiles,
      and(
        eq(doctorProfiles.id, patientMaterialUsages.doctorId),
        eq(doctorProfiles.tenantId, patientMaterialUsages.tenantId),
      ),
    )
    .leftJoin(users, and(eq(users.id, doctorProfiles.userId), eq(users.tenantId, doctorProfiles.tenantId)))
    .where(tenantWhere(patientMaterialUsages, scope, await usageVisibility(scope, ctx), ...conds))
    .orderBy(desc(patientMaterialUsages.createdAt))
    .limit(200);
  const ids = rows.map((r) => r.id);
  const lines = ids.length
    ? await scope.tx
        .select({
          rowId: patientMaterialUsageItems.id,
          usageId: patientMaterialUsageItems.patientUsageId,
          itemName: inventoryItems.name,
          unit: inventoryItems.unit,
          quantity: patientMaterialUsageItems.quantity,
        })
        .from(patientMaterialUsageItems)
        .innerJoin(
          inventoryItems,
          and(
            eq(inventoryItems.id, patientMaterialUsageItems.inventoryItemId),
            eq(inventoryItems.tenantId, patientMaterialUsageItems.tenantId),
          ),
        )
        .where(
          tenantWhere(
            patientMaterialUsageItems,
            scope,
            inArray(patientMaterialUsageItems.patientUsageId, ids),
          ),
        )
        .orderBy(asc(inventoryItems.name))
    : [];
  const allocs = hasPermission(ctx, "inventory.lot.read")
    ? await allocationsFor(
        scope,
        lines.map((l) => l.rowId),
      )
    : [];
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    finalizedAt: r.finalizedAt,
    appointmentId: r.appointmentId,
    appointmentStart: r.appointmentStart,
    branchName: r.branchName,
    roomName: r.roomName,
    doctorName: r.doctorFirst
      ? doctorDisplayName({ title: r.doctorTitle, firstName: r.doctorFirst, lastName: r.doctorLast! })
      : null,
    patient: { id: r.patientId, name: `${r.patientFirst} ${r.patientLast}`, patientNumber: r.patientNumber },
    items: lines
      .filter((l) => l.usageId === r.id)
      .map(({ rowId, itemName, unit, quantity }) => ({
        itemName,
        unit,
        quantity,
        lots: allocs
          .filter((a) => a.rowId === rowId)
          .map(({ lotNumber, expiryDate, quantity: q }) => ({ lotNumber, expiryDate, quantity: q })),
      })),
  }));
}

/** Hasta dosyası "Malzemeler" ve randevu detayı "Kullanılan malzemeler" (kapsam içi). */
export async function listPatientMaterialUsage(
  ctx: AuthContext,
  filter: { patientId?: unknown; appointmentId?: unknown },
) {
  requirePermission(ctx, "inventory.usage.read");
  return tenantQuery(ctx, async (scope) => {
    const conds: (SQL | undefined)[] = [];
    if (filter.patientId !== undefined) {
      const p = await loadVisiblePatient(scope, ctx, filter.patientId);
      conds.push(eq(patientMaterialUsages.patientId, p.id));
    }
    if (filter.appointmentId !== undefined) {
      const a = await loadAccessibleAppointment(scope, ctx, filter.appointmentId);
      conds.push(eq(patientMaterialUsages.appointmentId, a.id));
    }
    if (!conds.length) throw new AppError("VALIDATION", { fields: ["patientId"] });
    return listUsagesInScope(scope, ctx, conds);
  });
}

export async function getPatientMaterialUsage(ctx: AuthContext, rawId: unknown) {
  requirePermission(ctx, "inventory.usage.read");
  return tenantQuery(ctx, async (scope) => {
    const u = await loadUsage(scope, ctx, rawId);
    const [summary] = await listUsagesInScope(scope, ctx, [eq(patientMaterialUsages.id, u.id)]);
    const lines = await scope.tx
      .select({
        id: patientMaterialUsageItems.id,
        inventoryItemId: patientMaterialUsageItems.inventoryItemId,
        itemName: inventoryItems.name,
        unit: inventoryItems.unit,
        locationId: patientMaterialUsageItems.locationId,
        locationName: inventoryLocations.name,
        quantity: patientMaterialUsageItems.quantity,
        trackLots: inventoryItems.trackLots,
        available: sql<string>`case when ${inventoryItems.trackLots} then ${usableLotSum(
          sql`kliniva.patient_material_usage_items.tenant_id`,
          sql`kliniva.patient_material_usage_items.inventory_item_id`,
          sql`kliniva.patient_material_usage_items.location_id`,
        )} else coalesce((select b.quantity from kliniva.stock_balances b
          where b.tenant_id = kliniva.patient_material_usage_items.tenant_id
            and b.inventory_item_id = kliniva.patient_material_usage_items.inventory_item_id
            and b.location_id = kliniva.patient_material_usage_items.location_id), 0) end`,
      })
      .from(patientMaterialUsageItems)
      .innerJoin(
        inventoryItems,
        and(
          eq(inventoryItems.id, patientMaterialUsageItems.inventoryItemId),
          eq(inventoryItems.tenantId, patientMaterialUsageItems.tenantId),
        ),
      )
      .innerJoin(
        inventoryLocations,
        and(
          eq(inventoryLocations.id, patientMaterialUsageItems.locationId),
          eq(inventoryLocations.tenantId, patientMaterialUsageItems.tenantId),
        ),
      )
      .where(
        tenantWhere(patientMaterialUsageItems, scope, eq(patientMaterialUsageItems.patientUsageId, u.id)),
      )
      .orderBy(asc(inventoryItems.name));
    const canLots = hasPermission(ctx, "inventory.lot.read");
    const allocs = canLots
      ? await allocationsFor(
          scope,
          lines.map((l) => l.id),
        )
      : [];
    const views: UsageItemView[] = [];
    for (const l of lines) {
      const view: UsageItemView = {
        ...l,
        available: String(l.available),
        allocations: allocs
          .filter((a) => a.rowId === l.id)
          .map(({ stockLotId, lotNumber, expiryDate, quantity }) => ({
            stockLotId,
            lotNumber,
            expiryDate,
            quantity,
          })),
        suggested: [],
        lotOptions: [],
        shortfall: false,
      };
      // Taslak: FEFO önizlemesi + elle seçim seçenekleri (stok düşmez; kesinleştirmede sunucu yeniden hesaplar).
      if (canLots && l.trackLots && u.status === "DRAFT") {
        const { today } = await locationToday(scope, l.locationId);
        const cands = await lotCandidates(scope, l.inventoryItemId, l.locationId);
        view.lotOptions = fefoOrder(cands, today).map((c) => ({
          stockLotId: c.id,
          lotNumber: c.lotNumber,
          expiryDate: c.expiryDate,
          quantity: fromMilli(c.quantityMilli),
          available: fromMilli(c.quantityMilli),
        }));
        if (!view.allocations.length) {
          const res = fefoAllocate(cands, toMilli(l.quantity), today);
          view.shortfall = res.shortfallMilli > 0;
          view.suggested = res.allocations.map((a) => ({
            stockLotId: a.lotId,
            lotNumber: a.lotNumber,
            expiryDate: a.expiryDate,
            quantity: fromMilli(a.quantityMilli),
          }));
        }
      }
      views.push(view);
    }
    return {
      ...summary!,
      branchId: u.branchId,
      roomId: u.roomId,
      voidReason: u.voidReason,
      notes: u.notesEncrypted ? decryptField(u.notesEncrypted, notesAad(scope.tenantId, u.id)) : null,
      lines: views,
    };
  });
}

// ---------------------------------------------------------------- hizmet malzeme şablonları (yalnızca öneri)

export async function listServiceMaterialTemplates(ctx: AuthContext, rawServiceId: unknown) {
  requirePermission(ctx, "inventory.read");
  const serviceId = parseId(rawServiceId);
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select({
        inventoryItemId: serviceMaterialTemplates.inventoryItemId,
        itemName: inventoryItems.name,
        unit: inventoryItems.unit,
        defaultQuantity: serviceMaterialTemplates.defaultQuantity,
        required: serviceMaterialTemplates.required,
      })
      .from(serviceMaterialTemplates)
      .innerJoin(
        inventoryItems,
        and(
          eq(inventoryItems.id, serviceMaterialTemplates.inventoryItemId),
          eq(inventoryItems.tenantId, serviceMaterialTemplates.tenantId),
        ),
      )
      .where(
        tenantWhere(
          serviceMaterialTemplates,
          scope,
          eq(serviceMaterialTemplates.clinicalServiceId, serviceId),
        ),
      )
      .orderBy(asc(inventoryItems.name)),
  );
}

/** Şablonu verilen listeyle eşitler. Şablon stok DÜŞÜRMEZ. */
export async function setServiceMaterialTemplates(ctx: AuthContext, input: unknown): Promise<void> {
  requirePermission(ctx, "inventory.item.update");
  const data = parseInput(templateInput, input);
  await tenantQuery(ctx, async (scope) => {
    const [svc] = await scope.tx
      .select({ id: clinicalServices.id })
      .from(clinicalServices)
      .where(tenantWhere(clinicalServices, scope, eq(clinicalServices.id, data.clinicalServiceId)));
    if (!svc) throw new AppError("NOT_FOUND");
    for (const it of data.items) await loadItem(scope, it.inventoryItemId);
    await scope.tx
      .delete(serviceMaterialTemplates)
      .where(
        tenantWhere(serviceMaterialTemplates, scope, eq(serviceMaterialTemplates.clinicalServiceId, svc.id)),
      );
    for (const it of data.items) {
      await scope.tx
        .insert(serviceMaterialTemplates)
        .values({
          tenantId: scope.tenantId,
          clinicalServiceId: svc.id,
          inventoryItemId: it.inventoryItemId,
          defaultQuantity: it.defaultQuantity,
          required: it.required,
        })
        .onConflictDoUpdate({
          target: [
            serviceMaterialTemplates.tenantId,
            serviceMaterialTemplates.clinicalServiceId,
            serviceMaterialTemplates.inventoryItemId,
          ],
          set: { defaultQuantity: it.defaultQuantity, required: it.required },
        });
    }
    await writeAudit(scope, actorOf(ctx), {
      action: "SERVICE_MATERIAL_TEMPLATE_UPDATED",
      entityType: "clinical_service",
      entityId: svc.id,
      metadata: { serviceId: svc.id, itemCount: data.items.length },
    });
  });
}
