import { z } from "zod";
import { isValidDate } from "@/lib/time";
import { uuidSchema } from "@/server/validation";

/**
 * Stok uygulama servislerinin GİRDİ sözleşmeleri — server action / HTTP / (ileride) Voice AI aynı şemaları kullanır.
 * Örn. "Bu hastada 2 enjektör ve 1 punch kullanıldı." → RecordMaterialUsageInput. (Bu sprintte AI bağlantısı YOK.)
 * Miktarlar ondalıklı string (numeric(14,3)) — float kullanılmaz.
 */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optUuid = z.preprocess(blank, uuidSchema.optional());
const optText = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());
const boolish = z.preprocess((v) => v === true || v === "true" || v === "on" || v === "1", z.boolean());

export const INVENTORY_UNITS = [
  "PIECE",
  "BOX",
  "PACK",
  "BOTTLE",
  "ML",
  "LITER",
  "GRAM",
  "KG",
  "PAIR",
  "SET",
  "OTHER",
] as const;

/** Pozitif miktar: en fazla 3 ondalık, 1.000.000.000'dan küçük. String olarak normalize edilir. */
export const quantitySchema = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(",", ".") : v),
  z
    .string()
    .regex(/^\d{1,9}(\.\d{1,3})?$/, "invalid quantity")
    .refine((v) => Number(v) > 0, "quantity must be positive"),
);
const optQuantity = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : typeof v === "number" ? String(v) : v),
  z
    .string()
    .trim()
    .regex(/^\d{1,9}(\.\d{1,3})?$/)
    .optional(),
);

const pageFields = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};

export const categoryInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: optText(300),
  active: z.preprocess((v) => (v === undefined ? true : v), boolish),
});

const optDate = z.preprocess(blank, z.string().refine(isValidDate, "invalid date").optional());
const lotNumberField = z.preprocess(blank, z.string().trim().min(1).max(64).optional());

export const itemInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    code: optText(40),
    barcode: optText(64),
    categoryId: optUuid,
    unit: z.enum(INVENTORY_UNITS).default("PIECE"),
    trackInventory: z.preprocess((v) => (v === undefined ? true : v), boolish),
    minimumStockLevel: optQuantity,
    description: optText(500),
    active: z.preprocess((v) => (v === undefined ? true : v), boolish),
    /** Lot takibi / SKT takibi — SKT takibi lot takibini gerektirir (DB CHECK ile de). */
    trackLots: z.preprocess((v) => (v === undefined ? false : v), boolish),
    trackExpiry: z.preprocess((v) => (v === undefined ? false : v), boolish),
  })
  .refine((v) => !v.trackExpiry || v.trackLots, {
    path: ["trackExpiry"],
    message: "SKT takibi lot takibi gerektirir",
  });

export const locationInput = z
  .object({
    branchId: uuidSchema,
    type: z.enum(["BRANCH_WAREHOUSE", "ROOM"]),
    roomId: optUuid,
    name: optText(80),
  })
  .refine((v) => (v.type === "ROOM") === Boolean(v.roomId), { path: ["roomId"] });

export const addStockInput = z.object({
  inventoryItemId: uuidSchema,
  locationId: uuidSchema,
  quantity: quantitySchema,
  kind: z.enum(["INITIAL_STOCK", "PURCHASE"]).default("PURCHASE"),
  reference: optText(80),
  reason: optText(300),
  /** Lot takipli ürün: zorunlu. Aynı lokasyonda aynı numaralı lot varsa ona eklenir. */
  lotNumber: lotNumberField,
  expiryDate: optDate,
  receivedAt: optDate,
});
export type AddStockInput = z.input<typeof addStockInput>;

export const adjustStockInput = z.object({
  inventoryItemId: uuidSchema,
  locationId: uuidSchema,
  direction: z.enum(["IN", "OUT"]),
  /** OUT için WRITE_OFF (fire / son kullanma) seçilebilir. */
  kind: z.enum(["ADJUSTMENT", "WRITE_OFF"]).default("ADJUSTMENT"),
  quantity: quantitySchema,
  reason: z.string().trim().min(3).max(300),
  /** Lot takipli ürün: zorunlu (lot bu lokasyonda olmalı). */
  stockLotId: optUuid,
});
export type AdjustStockInput = z.input<typeof adjustStockInput>;

export const transferStockInput = z.object({
  inventoryItemId: uuidSchema,
  fromLocationId: uuidSchema,
  toLocationId: uuidSchema,
  quantity: quantitySchema,
  reason: optText(300),
  /** Lot takipli ürün: kaynak lot (zorunlu). Hedefte aynı lot kimliği korunur. */
  fromStockLotId: optUuid,
});
export type TransferStockInput = z.input<typeof transferStockInput>;

export const getInventoryInput = z.object({
  branchId: optUuid,
  locationId: optUuid,
  categoryId: optUuid,
});
export type GetInventoryInput = z.input<typeof getInventoryInput>;

export const listItemsInput = z.object({
  q: optText(100),
  categoryId: optUuid,
  status: z.enum(["active", "inactive", "all"]).default("active"),
  ...pageFields,
});

export const listMovementsInput = z.object({
  inventoryItemId: optUuid,
  branchId: optUuid,
  locationId: optUuid,
  stockLotId: optUuid,
  movementType: z.preprocess(
    blank,
    z
      .enum([
        "INITIAL_STOCK",
        "PURCHASE",
        "ADJUSTMENT_IN",
        "ADJUSTMENT_OUT",
        "TRANSFER",
        "PATIENT_USAGE",
        "RETURN_FROM_PATIENT_USAGE",
        "WRITE_OFF",
      ])
      .optional(),
  ),
  from: z.preprocess(blank, z.string().refine(isValidDate).optional()),
  to: z.preprocess(blank, z.string().refine(isValidDate).optional()),
  ...pageFields,
});

export const createUsageInput = z.object({
  patientId: uuidSchema,
  appointmentId: optUuid,
  /** Randevu yoksa zorunlu. */
  branchId: optUuid,
  notes: optText(2000),
  /** Randevunun hizmetine bağlı malzeme şablonunu taslağa öneri olarak ekle. */
  applyTemplate: z.preprocess((v) => (v === undefined ? true : v), boolish),
});
export type CreateUsageInput = z.input<typeof createUsageInput>;

export const usageItemInput = z.object({
  inventoryItemId: uuidSchema,
  locationId: uuidSchema,
  quantity: quantitySchema,
});

export const voidInput = z.object({ reason: z.string().trim().min(3).max(500) });

/** Voice AI'ye hazır tek adımlı kayıt: taslak + kalemler (+ isteğe bağlı kesinleştirme). */
export const recordMaterialUsageInput = z.object({
  patientId: uuidSchema,
  appointmentId: optUuid,
  branchId: optUuid,
  items: z
    .array(
      z.object({
        inventoryItemId: uuidSchema,
        quantity: quantitySchema,
        locationId: optUuid,
        /** Elle lot seçimi (FEFO'yu geçersiz kılar); yoksa kesinleştirmede FEFO. */
        lots: z
          .array(z.object({ stockLotId: uuidSchema, quantity: quantitySchema }))
          .max(20)
          .optional(),
      }),
    )
    .min(1)
    .max(50),
  finalize: z.preprocess((v) => (v === undefined ? false : v), boolish),
});
export type RecordMaterialUsageInput = z.input<typeof recordMaterialUsageInput>;
/** Sprint 5 adı (aynı şema). */
export const recordPatientMaterialUsageInput = recordMaterialUsageInput;
export type RecordPatientMaterialUsageInput = RecordMaterialUsageInput;

/** Kullanım kalemi için elle lot tahsisi (boş liste = otomatik FEFO). */
export const usageAllocationInput = z.object({
  lots: z.array(z.object({ stockLotId: uuidSchema, quantity: quantitySchema })).max(20),
});

export const templateInput = z.object({
  clinicalServiceId: uuidSchema,
  items: z
    .array(
      z.object({
        inventoryItemId: uuidSchema,
        defaultQuantity: quantitySchema,
        required: z.preprocess((v) => (v === undefined ? false : v), boolish),
      }),
    )
    .max(50),
});

export const reconcileInput = z.object({
  inventoryItemId: uuidSchema,
  locationId: uuidSchema,
  apply: z.preprocess((v) => (v === undefined ? false : v), boolish),
});

// ---------------------------------------------------------------- Sprint 5: lot / SKT
export const getExpiringLotsInput = z.object({
  branchId: optUuid,
  locationId: optUuid,
  categoryId: optUuid,
  /** Boşsa klinik ayarı (expiryWarningDays). */
  days: z.preprocess(blank, z.coerce.number().int().min(1).max(365).optional()),
  kind: z.enum(["expiring", "expired"]).default("expiring"),
});
export type GetExpiringLotsInput = z.input<typeof getExpiringLotsInput>;

export const getStockByLotInput = z.object({
  inventoryItemId: optUuid,
  locationId: optUuid,
  branchId: optUuid,
  includeEmpty: z.preprocess((v) => (v === undefined ? false : v), boolish),
});
export type GetStockByLotInput = z.input<typeof getStockByLotInput>;

export const selectFefoInput = z.object({
  inventoryItemId: uuidSchema,
  locationId: uuidSchema,
  quantity: quantitySchema,
});

export const findLotTraceInput = z.object({ stockLotId: uuidSchema });
export type FindLotTraceInput = z.input<typeof findLotTraceInput>;

export const recallLotInput = z.object({ stockLotId: uuidSchema, reason: z.string().trim().min(5).max(500) });
export const correctLotInput = z.object({
  stockLotId: uuidSchema,
  expiryDate: z.string().refine(isValidDate, "invalid date"),
  reason: z.string().trim().min(5).max(300),
});
export const writeOffLotInput = z.object({
  stockLotId: uuidSchema,
  /** Boşsa lotun tamamı. */
  quantity: z.preprocess(blank, quantitySchema.optional()),
  reason: z.string().trim().min(3).max(300),
});
export const physicalCountInput = z.object({
  inventoryItemId: uuidSchema,
  locationId: uuidSchema,
  stockLotId: optUuid,
  countedQuantity: z.preprocess(
    (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(",", ".") : v),
    z.string().regex(/^\d{1,9}(\.\d{1,3})?$/),
  ),
  /** false → yalnızca karşılaştırma (kuru çalıştırma); true → fark varsa düzeltme hareketi. */
  apply: z.preprocess((v) => (v === undefined ? false : v), boolish),
  reason: optText(300),
});

export { toMilli, fromMilli, formatQuantity } from "@/lib/quantity";
