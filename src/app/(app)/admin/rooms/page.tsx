import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { accessibleBranchOptions, listRooms, ROOM_TYPES } from "@/server/services/org";
import { ActionForm, Field, InlineAction, SelectField } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader, Panel, ROOM_TYPE_LABELS, StatusBadge } from "@/components/ui";
import { createRoomAction, toggleRoomAction, updateRoomAction } from "@/app/actions/org";

export const metadata: Metadata = { title: "Odalar" };

const typeOptions = ROOM_TYPES.map((t) => ({ value: t, label: ROOM_TYPE_LABELS[t] ?? t }));

export default async function RoomsPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; inactive?: string }>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "room.read")) return <Forbidden />;
  const { branch, inactive } = await searchParams;
  const branchOptions = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];
  const selected = branchOptions.some((b) => b.id === branch) ? branch : undefined;
  const rows = await listRooms(ctx, { branchId: selected, includeInactive: inactive === "1" });
  const canManage = hasPermission(ctx, "room.manage");

  return (
    <section>
      <PageHeader
        title="Odalar"
        description="Muayene, işlem ve tedavi odaları. Odalar silinmez; pasifleştirilir."
      />

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <form className="flex flex-wrap items-end gap-3" role="search">
          <div>
            <label htmlFor="branch" className="label">
              Şube
            </label>
            <select id="branch" name="branch" defaultValue={selected ?? ""} className="input min-w-48">
              <option value="">Tüm şubeler</option>
              {branchOptions.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="inactive"
              value="1"
              defaultChecked={inactive === "1"}
              className="size-4"
            />
            Pasifleri göster
          </label>
          <button type="submit" className="btn-ghost">
            Filtrele
          </button>
        </form>
        {canManage && branchOptions.length ? (
          <div className="ml-auto">
            <Panel summary="Oda ekle">
              <ActionForm
                action={createRoomAction}
                submitLabel="Oda oluştur"
                className="grid gap-4 sm:grid-cols-3"
              >
                <SelectField
                  idPrefix="nr"
                  label="Şube"
                  name="branchId"
                  required
                  defaultValue={selected ?? branchOptions[0]?.id}
                  options={branchOptions.map((b) => ({ value: b.id, label: b.name }))}
                />
                <Field idPrefix="nr" label="Oda adı" name="name" required placeholder="Oda 1" />
                <Field idPrefix="nr" label="Kod" name="code" placeholder="R1" />
                <SelectField
                  idPrefix="nr"
                  label="Tür"
                  name="type"
                  defaultValue="EXAMINATION"
                  options={typeOptions}
                />
                <Field idPrefix="nr" label="Kat" name="floor" />
                <Field idPrefix="nr" label="Açıklama" name="description" />
              </ActionForm>
            </Panel>
          </div>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Oda bulunamadı">Seçili filtrede oda yok.</EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <article key={r.id} className="card flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">
                    {r.name}
                    {r.code ? <span className="ml-2 font-mono text-xs text-slate-500">{r.code}</span> : null}
                  </h2>
                  <p className="text-sm text-slate-500">
                    {r.branchName}
                    {r.floor ? ` · Kat ${r.floor}` : ""}
                  </p>
                </div>
                <StatusBadge active={r.active} />
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="badge badge-brand">{ROOM_TYPE_LABELS[r.type] ?? r.type}</span>
              </div>
              {r.description ? (
                <p className="text-sm text-slate-600 dark:text-slate-400">{r.description}</p>
              ) : null}
              {canManage ? (
                <div className="mt-auto flex flex-wrap items-start gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <details className="panel w-full">
                    <summary className="btn-ghost btn-sm">Düzenle</summary>
                    <ActionForm action={updateRoomAction} submitLabel="Kaydet" className="mt-3 grid gap-3">
                      <input type="hidden" name="id" value={r.id} />
                      <Field
                        idPrefix={`er-${r.id}`}
                        label="Oda adı"
                        name="name"
                        required
                        defaultValue={r.name}
                      />
                      <Field idPrefix={`er-${r.id}`} label="Kod" name="code" defaultValue={r.code ?? ""} />
                      <SelectField
                        idPrefix={`er-${r.id}`}
                        label="Tür"
                        name="type"
                        defaultValue={r.type}
                        options={typeOptions}
                      />
                      <Field idPrefix={`er-${r.id}`} label="Kat" name="floor" defaultValue={r.floor ?? ""} />
                      <Field
                        idPrefix={`er-${r.id}`}
                        label="Açıklama"
                        name="description"
                        defaultValue={r.description ?? ""}
                      />
                    </ActionForm>
                  </details>
                  <InlineAction
                    action={toggleRoomAction}
                    fields={{ id: r.id, active: String(!r.active) }}
                    label={r.active ? "Pasifleştir" : "Aktifleştir"}
                    variant={r.active ? "danger" : "ghost"}
                  />
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
