import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { listLabPanels, parametersToText } from "@/server/services/labs";
import { createLabPanelAction, updateLabPanelAction } from "@/app/actions/labs";
import { ActionForm, Field } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader, SectionCard, StatusBadge } from "@/components/ui";

export const metadata: Metadata = { title: "Tahlil tipleri" };

const HINT =
  "Her satıra bir parametre: Ad | birim | alt sınır | üst sınır (birim ve sınırlar isteğe bağlı). Örnek: Hemoglobin | g/dL | 12 | 16";

function ParametersField({ id, defaultValue }: { id: string; defaultValue?: string }) {
  return (
    <div className="sm:col-span-2">
      <label htmlFor={id} className="label">
        Parametreler
      </label>
      <textarea
        id={id}
        name="parameters"
        required
        rows={6}
        maxLength={6000}
        defaultValue={defaultValue}
        placeholder={"Hemoglobin | g/dL | 12 | 16\nLökosit (WBC) | 10³/µL | 4 | 10"}
        aria-describedby={`${id}-hint`}
        className="input font-mono text-[13px] leading-relaxed"
      />
      <p id={`${id}-hint`} className="hint">
        {HINT}
      </p>
    </div>
  );
}

/**
 * Tahlil tipleri — parametre ve referans aralıkları. Değişiklik eski sonuçları etkilemez (sonuç girildiği andaki
 * aralığı saklar). Silinmez; pasifleştirilen tip yeni sonuçta seçilemez.
 */
export default async function LabPanelsPage() {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "clinic.manage")) return <Forbidden />;
  const panels = await listLabPanels(ctx);
  return (
    <section className="grid gap-6">
      <PageHeader
        eyebrow="Ayarlar"
        title="Tahlil tipleri"
        description="Hasta dosyasındaki Tahliller sekmesinde kullanılan paneller ve referans aralıkları."
      />
      <SectionCard title="Yeni tahlil tipi">
        <ActionForm action={createLabPanelAction} submitLabel="Ekle" className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Ad"
            name="name"
            required
            maxLength={80}
            placeholder="örn. Hemogram"
            idPrefix="lp-new"
          />
          <div className="hidden sm:block" />
          <ParametersField id="lp-new-parameters" />
        </ActionForm>
      </SectionCard>
      {panels.length === 0 ? (
        <EmptyState title="Henüz tahlil tipi yok" icon="exam" />
      ) : (
        <div className="grid gap-3">
          {panels.map((p) => (
            <details key={p.id} className="card">
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {p.name}{" "}
                  <span className="text-sm font-normal text-slate-500">
                    · {p.parameters.length} parametre
                  </span>
                </span>
                <StatusBadge active={p.active} />
              </summary>
              <ActionForm
                action={updateLabPanelAction}
                submitLabel="Kaydet"
                className="mt-4 grid gap-4 sm:grid-cols-2"
              >
                <input type="hidden" name="id" value={p.id} />
                <Field
                  label="Ad"
                  name="name"
                  required
                  maxLength={80}
                  defaultValue={p.name}
                  idPrefix={`lp-${p.id}`}
                />
                <label className="flex min-h-11 items-center gap-2 self-end text-sm">
                  <input type="checkbox" name="active" value="true" defaultChecked={p.active} />
                  Aktif
                </label>
                <ParametersField id={`lp-${p.id}-parameters`} defaultValue={parametersToText(p.parameters)} />
              </ActionForm>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
