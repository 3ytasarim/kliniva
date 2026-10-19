import { FlaskConical } from "lucide-react";
import { ActionForm, Field } from "@/components/action-form";
import { EmptyState, SectionCard } from "@/components/ui";
import { formatDateTime } from "@/components/patient-ui";
import { addLabResultAction, voidLabResultAction } from "@/app/actions/labs";
import { cn } from "@/lib/cn";
import {
  LAB_FLAG_LABELS,
  type LabFlag,
  type LabPanel,
  type LabParameter,
  type LabResultItem,
} from "@/types/labs";

/** Tahliller (sağlık verisi) — sonuç girişi, parametre değişim tablosu ve sonuç listesi. Sunucu bileşeni. */
const dmy = (d: string) => d.split("-").reverse().join(".");
const range = (p: Pick<LabParameter, "low" | "high" | "unit">) =>
  p.low !== null && p.high !== null
    ? `${p.low}–${p.high}`
    : p.low !== null
      ? `≥ ${p.low}`
      : p.high !== null
        ? `≤ ${p.high}`
        : "";

function FlagValue({ value, flag }: { value: string; flag: LabFlag }) {
  return (
    <span
      className={cn(
        "font-semibold tabular-nums",
        flag === "H" && "text-red-700 dark:text-red-400",
        flag === "L" && "text-sky-700 dark:text-sky-400",
      )}
    >
      {value}
      {flag ? (
        <span className="ml-1 text-[10px] font-bold" title={LAB_FLAG_LABELS[flag]}>
          {flag === "H" ? "↑" : "↓"}
          <span className="sr-only"> {LAB_FLAG_LABELS[flag]}</span>
        </span>
      ) : null}
    </span>
  );
}

export function LabEntry({
  patientId,
  panels,
  selected,
  today,
}: {
  patientId: string;
  panels: LabPanel[];
  selected: LabPanel | null;
  today: string;
}) {
  return (
    <SectionCard
      title="Yeni tahlil sonucu"
      description="Tahlil tipini seçin, değerleri girin · boş bırakılan parametre kaydedilmez"
    >
      <form className="mb-4 flex flex-wrap items-end gap-2" aria-label="Tahlil tipi seç">
        <input type="hidden" name="tab" value="labs" />
        <div>
          <label htmlFor="lab-panel" className="label">
            Tahlil tipi
          </label>
          <select id="lab-panel" name="panel" defaultValue={selected?.id ?? ""} className="input">
            <option value="">Seçin</option>
            {panels.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn-ghost">
          Seç
        </button>
      </form>
      {selected ? (
        <ActionForm
          action={addLabResultAction}
          submitLabel="Sonucu kaydet"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          <input type="hidden" name="patientId" value={patientId} />
          <input type="hidden" name="panelId" value={selected.id} />
          <Field
            label="Numune tarihi"
            name="sampleDate"
            type="date"
            required
            defaultValue={today}
            max={today}
            idPrefix="lr"
          />
          <div className="hidden lg:block" />
          <div className="hidden sm:block" />
          {selected.parameters.map((p) => (
            <Field
              key={p.key}
              label={`${p.name}${p.unit ? ` (${p.unit})` : ""}`}
              name={`v_${p.key}`}
              maxLength={40}
              inputMode="decimal"
              hint={range(p) ? `Referans: ${range(p)}` : undefined}
              idPrefix="lr"
            />
          ))}
        </ActionForm>
      ) : (
        <p className="hint">
          {panels.length
            ? "Değer girmek için bir tahlil tipi seçin."
            : "Önce Ayarlar → Tahlil tipleri'nden bir tip tanımlayın."}
        </p>
      )}
    </SectionCard>
  );
}

/** Tahlil tipi başına: satırlar parametre, sütunlar son 6 geçerli sonuç (eskiden yeniye). */
export function LabTrends({ results }: { results: LabResultItem[] }) {
  const active = results.filter((r) => r.status === "ACTIVE" && !r.integrityError);
  const panels = [...new Set(active.map((r) => r.panelId))];
  if (!panels.length) return null;
  return (
    <SectionCard title="Değişim" description="Her tahlil tipinin son 6 sonucu · ↑ yüksek, ↓ düşük">
      <div className="grid gap-6">
        {panels.map((pid) => {
          const rs = active
            .filter((r) => r.panelId === pid)
            .slice(0, 6)
            .reverse();
          const params = new Map<string, LabParameter>();
          for (const r of rs) for (const v of r.values) if (!params.has(v.key)) params.set(v.key, v);
          return (
            <div key={pid} className="min-w-0">
              <h3 className="mb-2 text-sm font-semibold">{rs[0]!.panelName}</h3>
              <div className="overflow-x-auto">
                <table className="table" data-testid="lab-trend">
                  <thead>
                    <tr>
                      <th>Parametre</th>
                      <th>Referans</th>
                      {rs.map((r) => (
                        <th key={r.id} className="text-right">
                          {dmy(r.sampleDate)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...params.values()].map((p) => (
                      <tr key={p.key}>
                        <td className="whitespace-nowrap font-medium">
                          {p.name}
                          {p.unit ? <span className="ml-1 text-xs text-slate-500">{p.unit}</span> : null}
                        </td>
                        <td className="whitespace-nowrap text-xs text-slate-500">{range(p) || "—"}</td>
                        {rs.map((r) => {
                          const v = r.values.find((x) => x.key === p.key);
                          return (
                            <td key={r.id} className="whitespace-nowrap text-right">
                              {v ? (
                                <FlagValue value={v.value} flag={v.flag} />
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

export function LabResultList({
  patientId,
  results,
  canVoid,
}: {
  patientId: string;
  results: LabResultItem[];
  canVoid: boolean;
}) {
  return (
    <SectionCard
      title="Sonuçlar"
      description={`${results.filter((r) => r.status === "ACTIVE").length} geçerli sonuç`}
    >
      {results.length === 0 ? (
        <EmptyState title="Henüz tahlil sonucu yok" icon="exam" />
      ) : (
        <ul className="grid gap-3">
          {results.map((r) => (
            <li
              key={r.id}
              data-testid="lab-result"
              className={cn(
                "rounded-xl border border-line p-4 dark:border-line-dark",
                r.status === "VOIDED" && "opacity-60",
              )}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="grid size-9 place-items-center rounded-lg bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
                  <FlaskConical className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn("font-medium", r.status === "VOIDED" && "line-through")}>
                    {r.panelName} · {dmy(r.sampleDate)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {r.createdByName} · {formatDateTime(r.createdAt)}
                  </p>
                </div>
                {r.status === "VOIDED" ? (
                  <span className="badge badge-gray">Geçersiz</span>
                ) : r.abnormalCount ? (
                  <span className="badge badge-red">{r.abnormalCount} referans dışı</span>
                ) : (
                  <span className="badge badge-green">Referans içinde</span>
                )}
              </div>
              {r.integrityError ? (
                <p role="alert" className="mt-2 text-sm text-red-700">
                  Sonuç doğrulanamadı; yöneticinize bildirin.
                </p>
              ) : (
                <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  {r.values.map((v) => (
                    <div
                      key={v.key}
                      className="flex items-baseline justify-between gap-3 border-b border-dashed border-line py-1 dark:border-line-dark"
                    >
                      <dt className="truncate text-slate-600 dark:text-slate-300">{v.name}</dt>
                      <dd className="shrink-0 text-right">
                        <FlagValue value={v.value} flag={v.flag} />
                        {v.unit ? <span className="ml-1 text-xs text-slate-500">{v.unit}</span> : null}
                        {range(v) ? (
                          <span className="ml-2 text-[11px] text-slate-400">({range(v)})</span>
                        ) : null}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {r.voidReason ? <p className="mt-2 text-xs text-red-600">Geçersiz: {r.voidReason}</p> : null}
              {canVoid && r.status === "ACTIVE" ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-red-700 dark:text-red-400">
                    Geçersiz kıl
                  </summary>
                  <ActionForm
                    action={voidLabResultAction}
                    submitLabel="Onayla"
                    className="mt-2 grid max-w-md gap-2"
                  >
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="patientId" value={patientId} />
                    <Field
                      label="Gerekçe"
                      name="reason"
                      required
                      minLength={3}
                      maxLength={300}
                      hint="Sonuç silinmez; gerekçesiyle geçersiz görünür. Doğru değerleri yeni sonuç olarak girin."
                      idPrefix={`lv-${r.id.slice(0, 8)}`}
                    />
                  </ActionForm>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
