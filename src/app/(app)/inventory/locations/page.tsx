import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { listLocations } from "@/server/services/inventory";
import { accessibleBranchOptions, listRooms } from "@/server/services/org";
import { createLocationAction, setLocationActiveAction } from "@/app/actions/inventory";
import { ActionForm, Field, InlineAction, SelectField } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { InventoryNav, LOCATION_TYPE_LABELS } from "@/components/inventory-ui";

export const metadata: Metadata = { title: "Stok lokasyonları" };

/** Şube depoları ve oda stok lokasyonları (oda başına tek lokasyon). */
export default async function InventoryLocationsPage() {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "inventory.read")) return <Forbidden />;
  const locations = await listLocations(ctx);
  const canManage = hasPermission(ctx, "inventory.item.create");
  const branches = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];
  const rooms = canManage && hasPermission(ctx, "room.read") ? await listRooms(ctx) : [];
  const withLocation = new Set(locations.map((l) => l.roomId).filter(Boolean));
  const freeRooms = rooms.filter((r) => r.active && !withLocation.has(r.id));

  return (
    <section>
      <PageHeader title="Stok lokasyonları" description="Şube ana depoları ve oda stokları." />
      <InventoryNav current="/inventory/locations" />

      {locations.length === 0 ? (
        <EmptyState title="Henüz lokasyon yok">Önce bir şube deposu oluşturun.</EmptyState>
      ) : (
        <div className="card mb-6 overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Lokasyon</th>
                <th scope="col">Şube</th>
                <th scope="col">Tip</th>
                <th scope="col">Durum</th>
                <th scope="col">
                  <span className="sr-only">İşlem</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {locations.map((l) => (
                <tr key={l.id}>
                  <td className="font-medium">{l.name}</td>
                  <td>{l.branchName}</td>
                  <td>{LOCATION_TYPE_LABELS[l.type]}</td>
                  <td>
                    <StatusBadge active={l.active} />
                  </td>
                  <td className="text-right">
                    {hasPermission(ctx, "inventory.item.update") ? (
                      <InlineAction
                        action={setLocationActiveAction}
                        fields={{ id: l.id, active: l.active ? "false" : "true" }}
                        label={l.active ? "Pasifleştir" : "Aktifleştir"}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="card">
            <h2 className="mb-4 font-semibold">Yeni şube deposu</h2>
            <ActionForm action={createLocationAction} submitLabel="Depo oluştur" className="grid gap-3">
              <input type="hidden" name="type" value="BRANCH_WAREHOUSE" />
              <SelectField
                label="Şube"
                name="branchId"
                options={branches.map((b) => ({ value: b.id, label: b.name }))}
                required
                idPrefix="wh"
              />
              <Field label="Depo adı" name="name" required defaultValue="Ana Depo" idPrefix="wh" />
            </ActionForm>
          </div>
          <div className="card">
            <h2 className="mb-1 font-semibold">Oda stok lokasyonu</h2>
            <p className="hint mb-4">Randevunun odası stok kaynağı olarak önerilir.</p>
            {freeRooms.length === 0 ? (
              <p className="text-sm text-slate-500">Lokasyonu olmayan aktif oda yok.</p>
            ) : (
              <ul className="grid gap-2">
                {freeRooms.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700"
                  >
                    <span className="text-sm">
                      <span className="font-medium">{r.name}</span>{" "}
                      <span className="text-slate-500">· {r.branchName}</span>
                    </span>
                    <InlineAction
                      action={createLocationAction}
                      fields={{ type: "ROOM", branchId: r.branchId, roomId: r.id }}
                      label="Lokasyon oluştur"
                      variant="primary"
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
