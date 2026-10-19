import { HeartPulse, ShieldAlert } from "lucide-react";
import { ActionForm, SelectField } from "@/components/action-form";
import { SectionCard } from "@/components/ui";
import { updateHealthProfileAction } from "@/app/actions/patients";
import { BLOOD_TYPES, HABIT_OPTIONS, type HealthProfile } from "@/types/patients";

/**
 * Sağlık profili (özel nitelikli veri). Yalnızca patient.health.read ile render edilir; düzenleme
 * patient.health.write. Alerjiler hasta başlığında ve randevu ekranında belirgin uyarı olarak görünür.
 */
const habitLabel = (v: string | null) => HABIT_OPTIONS.find((o) => o.value === v)?.label ?? null;

export function AllergyAlert({ allergies, compact }: { allergies: string; compact?: boolean }) {
  if (!allergies.trim()) return null;
  return (
    <p
      role="note"
      aria-label="Alerji uyarısı"
      data-testid="allergy-alert"
      className={
        compact
          ? "inline-flex max-w-full items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700 ring-1 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/30"
          : "flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
      }
    >
      <ShieldAlert className={compact ? "size-3.5 shrink-0" : "mt-0.5 size-4 shrink-0"} aria-hidden="true" />
      <span className={compact ? "truncate" : ""}>
        <span className="font-semibold">Alerji: </span>
        {allergies}
      </span>
    </p>
  );
}

export function HealthProfileCard({
  patientId,
  profile,
  canEdit,
  integrityError,
}: {
  patientId: string;
  profile: HealthProfile | null;
  canEdit: boolean;
  integrityError?: boolean;
}) {
  const p: HealthProfile = profile ?? {
    bloodType: null,
    allergies: "",
    chronicConditions: "",
    medications: "",
    smoking: null,
    alcohol: null,
  };
  const rows: [string, string | null][] = [
    ["Kan grubu", p.bloodType],
    ["Kronik hastalıklar", p.chronicConditions || null],
    ["Düzenli ilaçlar", p.medications || null],
    ["Sigara", habitLabel(p.smoking)],
    ["Alkol", habitLabel(p.alcohol)],
  ];
  return (
    <SectionCard
      title="Sağlık bilgileri"
      description="Özel nitelikli kişisel veri · şifreli saklanır · erişim kayıt altındadır"
      action={<HeartPulse className="size-5 text-rose-400" aria-hidden="true" />}
    >
      {integrityError ? (
        <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-400">
          Sağlık bilgileri doğrulanamadı; yöneticinize bildirin.
        </p>
      ) : null}
      <div className="grid gap-3">
        <AllergyAlert allergies={p.allergies} />
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt>
              <dd className="mt-0.5 whitespace-pre-line break-words">{v || "—"}</dd>
            </div>
          ))}
        </dl>
      </div>
      {canEdit && !integrityError ? (
        <details className="mt-4 rounded-xl border border-line dark:border-line-dark">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-semibold">
            Sağlık bilgilerini düzenle
          </summary>
          <ActionForm
            action={updateHealthProfileAction}
            submitLabel="Kaydet"
            className="grid gap-3 px-4 pb-4 sm:grid-cols-2"
          >
            <input type="hidden" name="id" value={patientId} />
            <SelectField
              label="Kan grubu"
              name="bloodType"
              options={BLOOD_TYPES.map((b) => ({ value: b, label: b }))}
              defaultValue={p.bloodType ?? ""}
              placeholder="Bilinmiyor"
              idPrefix="hp"
            />
            <div className="hidden sm:block" />
            {(
              [
                ["allergies", "Alerjiler", "örn. Penisilin, lateks"],
                ["chronicConditions", "Kronik hastalıklar", "örn. Hipertansiyon"],
                ["medications", "Düzenli kullanılan ilaçlar", ""],
              ] as const
            ).map(([k, label, ph]) => (
              <div key={k} className="sm:col-span-2">
                <label htmlFor={`hp-${k}`} className="label">
                  {label}
                </label>
                <textarea
                  id={`hp-${k}`}
                  name={k}
                  rows={2}
                  maxLength={2000}
                  placeholder={ph}
                  defaultValue={p[k]}
                  className="input"
                />
              </div>
            ))}
            <SelectField
              label="Sigara"
              name="smoking"
              options={HABIT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              defaultValue={p.smoking ?? ""}
              placeholder="Belirtilmedi"
              idPrefix="hp"
            />
            <SelectField
              label="Alkol"
              name="alcohol"
              options={HABIT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              defaultValue={p.alcohol ?? ""}
              placeholder="Belirtilmedi"
              idPrefix="hp"
            />
          </ActionForm>
        </details>
      ) : null}
    </SectionCard>
  );
}
