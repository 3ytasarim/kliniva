"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/guards";
import { formToObject, runAction, runData, type ActionState, type DataResult } from "@/server/action-result";
import {
  addStock,
  adjustStock,
  createCategory,
  createInventoryItem,
  createLocation,
  setLocationActive,
  transferStock,
  updateInventoryItem,
} from "@/server/services/inventory";
import {
  addPatientMaterialUsageItem,
  createPatientMaterialUsage,
  finalizePatientMaterialUsage,
  removePatientMaterialUsageItem,
  setPatientMaterialUsageItemLots,
  setServiceMaterialTemplates,
  voidPatientMaterialUsage,
} from "@/server/services/material-usage";
import { correctLotMetadata, recallLot, recordPhysicalCount, writeOffLot } from "@/server/services/lots";
import { formatQuantity } from "@/lib/quantity";

/**
 * Stok server action'ları — ince sarmalayıcı: requireUser() → uygulama servisi (yetki, kapsam, kilit, audit).
 */
const revalidateInventory = (itemId?: string, lotId?: string) => {
  revalidatePath("/inventory");
  revalidatePath("/inventory/items");
  revalidatePath("/inventory/expiry");
  if (itemId) revalidatePath(`/inventory/items/${itemId}`);
  if (lotId) revalidatePath(`/inventory/lots/${lotId}`);
};

/** Lot takipli formlarda kaynak "lokasyon:lot" çifti tek seçimle gelir → iki alana ayrılır. */
function withLotRef(data: Record<string, string>, locKey: string, lotKey: string): Record<string, string> {
  const { lotRef, ...rest } = data;
  if (!lotRef) return rest;
  const [loc, lot] = lotRef.split(":");
  return { ...rest, [locKey]: loc ?? "", [lotKey]: lot ?? "" };
}

export async function createCategoryAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await createCategory(await requireUser(), formToObject(form));
    revalidateInventory();
    return "Kategori eklendi.";
  });
}

export async function createItemAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id } = await createInventoryItem(await requireUser(), formToObject(form));
    revalidateInventory();
    redirect(`/inventory/items/${id}`);
  });
}

export async function updateItemAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, ...rest } = formToObject(form);
    await updateInventoryItem(await requireUser(), id, {
      ...rest,
      active: form.get("active") === "on",
      trackLots: form.get("trackLots") === "on",
      trackExpiry: form.get("trackExpiry") === "on",
    });
    revalidateInventory(id);
    return "Ürün güncellendi.";
  });
}

export async function addStockAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    const r = await addStock(await requireUser(), data);
    revalidateInventory(data.inventoryItemId);
    return `Stok eklendi. Yeni bakiye: ${Number(r.balance)}.`;
  });
}

export async function adjustStockAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = withLotRef(formToObject(form), "locationId", "stockLotId");
    const r = await adjustStock(await requireUser(), data);
    revalidateInventory(data.inventoryItemId);
    return `Düzeltme kaydedildi. Yeni bakiye: ${Number(r.balance)}.`;
  });
}

export async function transferStockAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = withLotRef(formToObject(form), "fromLocationId", "fromStockLotId");
    await transferStock(await requireUser(), data);
    revalidateInventory(data.inventoryItemId);
    return "Transfer tamamlandı.";
  });
}

export async function createLocationAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await createLocation(await requireUser(), formToObject(form));
    revalidatePath("/inventory/locations");
    return "Lokasyon eklendi.";
  });
}

export async function setLocationActiveAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, active } = formToObject(form);
    await setLocationActive(await requireUser(), id, active === "true");
    revalidatePath("/inventory/locations");
    return "Lokasyon güncellendi.";
  });
}

// ---------------------------------------------------------------- hasta malzeme kullanımı

/** Randevudan / hastadan taslak oluşturur ve kullanım ekranına gider (şablon önerisi taslağa eklenir). */
export async function createUsageAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    const { id } = await createPatientMaterialUsage(await requireUser(), data);
    redirect(`/inventory/usages/${id}`);
  });
}

export async function addUsageItemAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { usageId, ...rest } = formToObject(form);
    await addPatientMaterialUsageItem(await requireUser(), usageId, rest);
    revalidatePath(`/inventory/usages/${usageId}`);
    return "Malzeme eklendi.";
  });
}

export async function updateUsageItemAction(input: {
  usageId: string;
  inventoryItemId: string;
  locationId: string;
  quantity: string;
}): Promise<DataResult<null>> {
  return runData(async () => {
    const { usageId, ...rest } = input;
    await addPatientMaterialUsageItem(await requireUser(), usageId, rest);
    revalidatePath(`/inventory/usages/${usageId}`);
    return null;
  });
}

export async function removeUsageItemAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { usageId, rowId } = formToObject(form);
    await removePatientMaterialUsageItem(await requireUser(), usageId, rowId);
    revalidatePath(`/inventory/usages/${usageId}`);
    return "Kaldırıldı.";
  });
}

export async function finalizeUsageAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { usageId } = formToObject(form);
    await finalizePatientMaterialUsage(await requireUser(), usageId);
    revalidatePath(`/inventory/usages/${usageId}`);
    revalidateInventory();
    return "Kullanım kesinleşti; stok düşüldü.";
  });
}

export async function voidUsageAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { usageId, reason } = formToObject(form);
    await voidPatientMaterialUsage(await requireUser(), usageId, { reason });
    revalidatePath(`/inventory/usages/${usageId}`);
    revalidateInventory();
    return "Kullanım geçersiz kılındı; stok iade hareketleriyle geri eklendi.";
  });
}

/** Form: clinicalServiceId + itemId (çoklu) + qty_<itemId> + req_<itemId>. */
export async function setTemplateAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const clinicalServiceId = String(form.get("clinicalServiceId") ?? "");
    const items = form
      .getAll("itemId")
      .map(String)
      .map((id) => ({
        inventoryItemId: id,
        defaultQuantity: String(form.get(`qty_${id}`) ?? ""),
        required: form.get(`req_${id}`) === "on",
      }))
      .filter((i) => i.defaultQuantity !== "");
    await setServiceMaterialTemplates(await requireUser(), { clinicalServiceId, items });
    revalidatePath("/inventory/templates");
    return "Malzeme şablonu kaydedildi (yalnızca öneri; stok düşürmez).";
  });
}

/** Taslak kalem için elle lot seçimi. Form: usageId, rowId, lot_<stockLotId> = miktar (boşlar yok sayılır).
 *  mode=auto → seçim temizlenir (kesinleştirmede otomatik FEFO). */
export async function setUsageLotsAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const usageId = String(form.get("usageId") ?? "");
    const rowId = String(form.get("rowId") ?? "");
    const lots =
      form.get("mode") === "auto"
        ? []
        : [...form.entries()]
            .filter(
              ([k, v]) =>
                k.startsWith("lot_") && String(v).trim() !== "" && Number(String(v).replace(",", ".")) > 0,
            )
            .map(([k, v]) => ({ stockLotId: k.slice(4), quantity: String(v) }));
    await setPatientMaterialUsageItemLots(await requireUser(), usageId, rowId, { lots });
    revalidatePath(`/inventory/usages/${usageId}`);
    return lots.length ? "Lot seçimi kaydedildi." : "Otomatik FEFO seçimine dönüldü.";
  });
}

// ---------------------------------------------------------------- lot / SKT

export async function recallLotAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    const r = await recallLot(await requireUser(), data);
    revalidateInventory(data.inventoryItemId, data.stockLotId);
    return `Lot geri çağrıldı (${r.affectedLots} lokasyon). Yeni kullanım ve transfer engellendi.`;
  });
}

export async function correctLotAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    await correctLotMetadata(await requireUser(), data);
    revalidateInventory(data.inventoryItemId, data.stockLotId);
    return "SKT düzeltildi.";
  });
}

export async function writeOffLotAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    const r = await writeOffLot(await requireUser(), data);
    revalidateInventory(data.inventoryItemId, data.stockLotId);
    return `İmha kaydedildi. Kalan: ${formatQuantity(r.remaining)}.`;
  });
}

/** Fiziksel sayım: onay kutusu işaretli değilse yalnızca karşılaştırma (kayıt yok). */
export async function physicalCountAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = withLotRef(formToObject(form), "locationId", "stockLotId");
    const apply = form.get("apply") === "on";
    const r = await recordPhysicalCount(await requireUser(), { ...data, apply });
    if (apply) revalidateInventory(data.inventoryItemId, data.stockLotId);
    const cmp = `Beklenen ${formatQuantity(r.expected)}, sayılan ${formatQuantity(r.counted)}, fark ${r.difference.startsWith("-") ? "−" : "+"}${formatQuantity(r.difference.replace("-", ""))}.`;
    if (!apply) return `${cmp} Kaydetmek için farkı onaylayın.`;
    return r.movementId
      ? `${cmp} Sayım kaydedildi; düzeltme hareketi oluşturuldu.`
      : `${cmp} Sayım kaydedildi; fark yok.`;
  });
}
