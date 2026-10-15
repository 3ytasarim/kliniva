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
  patientMaterialUsageItems,
  patientMaterialUsages,
  patients,
  rooms,
  serviceMaterialTemplates,
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
  usageItemInput,
  voidInput,
} from "@/server/inventory/contracts";

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
          eq(inventoryItems.trackLots, false),
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
  await scope.tx
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
      itemId: patientMaterialUsageItems.inventoryItemId,
      locationId: patientMaterialUsageItems.locationId,
      quantity: patientMaterialUsageItems.quantity,
      name: inventoryItems.name,
      active: inventoryItems.active,
      trackInventory: inventoryItems.trackInventory,
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

  // 1) Tüm kalemler deterministik sırada kilitlenir, 2) HEPSİ kontrol edilir, 3) ancak sonra hareketler eklenir.
  await lockStock(scope, items);
  const need = new Map<string, number>();
  for (const it of items)
    need.set(
      `${it.itemId}:${it.locationId}`,
      (need.get(`${it.itemId}:${it.locationId}`) ?? 0) + toMilli(it.quantity),
    );
  for (const it of items) {
    if (!it.trackInventory) continue;
    const have = await balanceMilli(scope, it.itemId, it.locationId);
    if (have < need.get(`${it.itemId}:${it.locationId}`)!) {
      throw new AppError("INSUFFICIENT_STOCK", {
        message: `${it.name} için ${it.locationName} lokasyonunda yeterli stok yok (mevcut ${fromMilli(have).replace(/\.?0+$/, "")}).`,
      });
    }
  }
  for (const it of items) {
    if (!it.trackInventory) continue;
    await scope.tx
      .insert(stockMovements)
      .values({
        tenantId: scope.tenantId,
        inventoryItemId: it.itemId,
        movementType: "PATIENT_USAGE",
        fromLocationId: it.locationId,
        quantity: it.quantity,
        patientId: u.patientId,
        appointmentId: u.appointmentId,
        patientUsageId: u.id,
        createdByUserId: ctx.userId,
      })
      .catch(mapMovementError);
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
  return u.id;
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
      await upsertItemInScope(scope, ctx, u, {
        inventoryItemId: it.inventoryItemId,
        quantity: it.quantity,
        locationId,
      });
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
  available: string;
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
  items: { itemName: string; unit: string; quantity: string }[];
};

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
      .map(({ itemName, unit, quantity }) => ({ itemName, unit, quantity })),
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
        available: sql<string>`coalesce((select b.quantity from kliniva.stock_balances b
          where b.tenant_id = kliniva.patient_material_usage_items.tenant_id
            and b.inventory_item_id = kliniva.patient_material_usage_items.inventory_item_id
            and b.location_id = kliniva.patient_material_usage_items.location_id), 0)`,
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
    return {
      ...summary!,
      branchId: u.branchId,
      roomId: u.roomId,
      voidReason: u.voidReason,
      notes: u.notesEncrypted ? decryptField(u.notesEncrypted, notesAad(scope.tenantId, u.id)) : null,
      lines: lines.map((l) => ({ ...l, available: String(l.available) })) as UsageItemView[],
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
