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
  setServiceMaterialTemplates,
  voidPatientMaterialUsage,
} from "@/server/services/material-usage";

/**
 * Stok server action'ları — ince sarmalayıcı: requireUser() → uygulama servisi (yetki, kapsam, kilit, audit).
 */
const revalidateInventory = (itemId?: string) => {
  revalidatePath("/inventory");
  revalidatePath("/inventory/items");
  if (itemId) revalidatePath(`/inventory/items/${itemId}`);
};

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
    await updateInventoryItem(await requireUser(), id, { ...rest, active: form.get("active") === "on" });
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
    const data = formToObject(form);
    const r = await adjustStock(await requireUser(), data);
    revalidateInventory(data.inventoryItemId);
    return `Düzeltme kaydedildi. Yeni bakiye: ${Number(r.balance)}.`;
  });
}

export async function transferStockAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
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
