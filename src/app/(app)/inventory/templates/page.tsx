import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { listClinicalServices } from "@/server/services/clinical-services";
import { listInventoryItems } from "@/server/services/inventory";
import { listServiceMaterialTemplates } from "@/server/services/material-usage";
import { setTemplateAction } from "@/app/actions/inventory";
import { ActionForm } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader } from "@/components/ui";
import { InventoryNav, UNIT_LABELS } from "@/components/inventory-ui";
import { formatQuantity } from "@/lib/quantity";

export const metadata: Metadata = { title: "Hizmet malzeme şablonları" };

/** Hizmete göre önerilen malzemeler — YALNIZCA öneri: kullanım ekranına gelir, stok düşürmez. */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string }>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "inventory.read") || !hasPermission(ctx, "service.read")) return <Forbidden />;
  const sp = await searchParams;
  const services = await listClinicalServices(ctx, { activeOnly: true });
  const serviceId = services.some((s) => s.id === sp.service) ? sp.service! : services[0]?.id;
  const current = serviceId ? await listServiceMaterialTemplates(ctx, serviceId) : [];
  const items = (await listInventoryItems(ctx, { limit: 100 })).items.filter((i) => i.trackInventory);
  const byItem = new Map(current.map((t) => [t.inventoryItemId, t]));
  const canEdit = hasPermission(ctx, "inventory.item.update");

  return (
    <section>
      <PageHeader
        title="Hizmet malzeme şablonları"
        description="Randevunun hizmeti için kullanım taslağına önerilecek malzemeler. Şablon stok düşürmez."
      />
      <InventoryNav current="/inventory/templates" />
      {services.length === 0 ? (
        <EmptyState title="Önce hizmet tanımlayın" />
      ) : (
        <div className="card grid gap-4">
          <form className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="tp-service" className="label">
                Hizmet
              </label>
              <select id="tp-service" name="service" defaultValue={serviceId} className="input">
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn-ghost">
              Seç
            </button>
          </form>
          {items.length === 0 ? (
            <p className="text-sm text-slate-500">Şablona eklenebilecek stok ürünü yok.</p>
          ) : canEdit ? (
            <ActionForm action={setTemplateAction} submitLabel="Şablonu kaydet" className="grid gap-2">
              <input type="hidden" name="clinicalServiceId" value={serviceId} />
              {items.map((i) => {
                const t = byItem.get(i.id);
                return (
                  <div
                    key={i.id}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700"
                  >
                    <label className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-sm">
                      <input type="checkbox" name="itemId" value={i.id} defaultChecked={Boolean(t)} />
                      <span className="font-medium">{i.name}</span>
                      <span className="text-slate-500">({UNIT_LABELS[i.unit]})</span>
                    </label>
                    <div className="w-28">
                      <label htmlFor={`q-${i.id}`} className="sr-only">
                        {i.name} varsayılan miktar
                      </label>
                      <input
                        id={`q-${i.id}`}
                        name={`qty_${i.id}`}
                        inputMode="decimal"
                        placeholder="Miktar"
                        defaultValue={t ? formatQuantity(t.defaultQuantity).replace(",", ".") : "1"}
                        className="input"
                      />
                    </div>
                    <label className="flex min-h-10 items-center gap-2 text-xs">
                      <input type="checkbox" name={`req_${i.id}`} defaultChecked={t?.required} />
                      Zorunlu
                    </label>
                  </div>
                );
              })}
            </ActionForm>
          ) : (
            <ul className="grid gap-1 text-sm">
              {current.map((t) => (
                <li key={t.inventoryItemId}>
                  {t.itemName} × {formatQuantity(t.defaultQuantity)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
