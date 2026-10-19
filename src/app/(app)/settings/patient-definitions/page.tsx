import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { listPatientLookups } from "@/server/services/patient-lookups";
import { createPatientLookupAction, togglePatientLookupAction } from "@/app/actions/patients";
import { ActionForm, Field, InlineAction } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { PatientLookup, PatientLookupKind } from "@/types/patients";

export const metadata: Metadata = { title: "Hasta tanımları" };

const KINDS: { kind: PatientLookupKind; title: string; description: string; placeholder: string }[] = [
  {
    kind: "SOURCE",
    title: "Hasta kaynakları",
    description:
      "Hastanın kliniği nereden bulduğu (Google, Instagram, tavsiye…). Panelde kaynak dağılımı buradan.",
    placeholder: "örn. Google",
  },
  {
    kind: "INSURER",
    title: "Özel sigorta kurumları",
    description: "Hasta kartında seçilen özel sağlık sigortaları.",
    placeholder: "örn. Allianz Sigorta",
  },
];

/** Kiracıya özel hasta tanımları. Silinmez; pasif tanım yeni kayıtta seçilemez, eski kayıtlarda görünür. */
export default async function PatientDefinitionsPage() {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "clinic.manage")) return <Forbidden />;
  const all = await listPatientLookups(ctx);
  return (
    <section className="grid gap-6">
      <PageHeader
        eyebrow="Ayarlar"
        title="Hasta tanımları"
        description="Hasta kartında kullanılan kaynak ve sigorta listeleri."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        {KINDS.map((k) => (
          <LookupCard key={k.kind} {...k} items={all.filter((l) => l.kind === k.kind)} />
        ))}
      </div>
    </section>
  );
}

function LookupCard({
  kind,
  title,
  description,
  placeholder,
  items,
}: {
  kind: PatientLookupKind;
  title: string;
  description: string;
  placeholder: string;
  items: PatientLookup[];
}) {
  return (
    <SectionCard title={title} description={description}>
      {items.length === 0 ? (
        <EmptyState title="Henüz tanım yok" icon="plus" />
      ) : (
        <ul className="mb-4 divide-y divide-slate-100 rounded-xl border border-line dark:divide-line-dark dark:border-line-dark">
          {items.map((l) => (
            <li
              key={l.id}
              className={cn(
                "flex items-center justify-between gap-3 px-3 py-2 text-sm",
                !l.active && "opacity-60",
              )}
            >
              <span className="font-medium">
                {l.name}
                {!l.active ? <span className="badge badge-gray ml-2">Pasif</span> : null}
              </span>
              <InlineAction
                action={togglePatientLookupAction}
                fields={{ id: l.id, active: String(!l.active) }}
                label={l.active ? "Pasifleştir" : "Etkinleştir"}
              />
            </li>
          ))}
        </ul>
      )}
      <ActionForm
        action={createPatientLookupAction}
        submitLabel="Ekle"
        className="flex flex-wrap items-end gap-3"
      >
        <input type="hidden" name="kind" value={kind} />
        <Field
          label="Yeni tanım"
          name="name"
          required
          maxLength={60}
          placeholder={placeholder}
          idPrefix={`pl-${kind}`}
        />
      </ActionForm>
    </SectionCard>
  );
}
