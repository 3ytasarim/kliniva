"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { SignaturePad } from "@/components/signature-pad";
import {
  ConsentChoices,
  DocumentBody,
  DocumentHeader,
  SIGNATURE_STATEMENT,
  SignerFields,
  resultMessage,
  signDocument,
  signerReady,
  type ConsentValue,
  type Signer,
} from "@/components/document-sign";
import { checkDuplicatesAction, createPatientAction, prepareDocumentAction } from "@/app/actions/patients";
import {
  SOCIAL_SECURITY_OPTIONS,
  type DocumentPreview,
  type DuplicateCandidate,
  type PatientLookup,
} from "@/types/patients";

/**
 * Yeni hasta + KVKK sihirbazı:
 *  1 Hasta bilgileri → 2 KVKK aydınlatma → 3 Açık rıza tercihleri → 4 İmza → 5 Tamamlandı
 *
 * Güvenlik notları:
 *  - Hasta 1. adım sonunda oluşturulur; belgeler tamamlanana kadar KVKK durumu "Bekliyor/Eksik" görünür.
 *  - Önizlenen içerik sunucudaki DEĞİŞMEZ snapshot'tır; imzada önizlenen contentSha256 geri gönderilir (TOCTOU).
 *  - İmza yalnızca statik PNG olarak gönderilir; çizim koordinatları saklanmaz.
 *  - Açık rızayı reddetmek (DENIED) geçerli bir karardır; kaydı veya hizmeti engellemez.
 */
type Branch = { id: string; name: string };

const STEPS = ["Hasta bilgileri", "KVKK", "Açık rıza", "İmza", "Tamamlandı"];

const FIELD_LABELS: Record<string, string> = {
  firstName: "Ad",
  lastName: "Soyad",
  phone: "Telefon",
  email: "E-posta",
  birthDate: "Doğum tarihi",
  primaryBranchId: "Ana şube",
  nationalId: "TC kimlik no",
  secondaryPhone: "İkinci telefon",
  emergencyContactPhone: "Acil durum telefonu",
};

const errorText = (r: Parameters<typeof resultMessage>[0]) => resultMessage(r, FIELD_LABELS);

export function PatientWizard({
  branches,
  defaultBranchId,
  hasConsentTemplate,
  hasDisclosureTemplate,
  lookups = [],
}: {
  branches: Branch[];
  defaultBranchId?: string;
  hasConsentTemplate: boolean;
  hasDisclosureTemplate: boolean;
  /** Etkin hasta tanımları (kaynak / sigorta). */
  lookups?: PatientLookup[];
}) {
  const sources = lookups.filter((l) => l.kind === "SOURCE");
  const insurers = lookups.filter((l) => l.kind === "INSURER");
  const [step, setStep] = useState(1);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({ primaryBranchId: defaultBranchId ?? "" });
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
  const [patient, setPatient] = useState<{ id: string; patientNumber: string } | null>(null);
  const [disclosure, setDisclosure] = useState<DocumentPreview | null>(null);
  const [informed, setInformed] = useState(false);
  const [consent, setConsent] = useState<DocumentPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, ConsentValue>>({});
  const [signer, setSigner] = useState<Signer>({ type: "PATIENT", guardianName: "", relationship: "" });
  const [signature, setSignature] = useState<string | null>(null);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  /** Açık rıza belgesini hazırla (şablon yoksa doğrudan imzaya / bitişe geç). */
  const prepareConsent = async (patientId: string, haveDisclosure: boolean) => {
    if (!hasConsentTemplate) return setStep(haveDisclosure ? 4 : 5);
    const prep = await prepareDocumentAction({
      patientId,
      type: "EXPLICIT_CONSENT",
      branchId: values.primaryBranchId || undefined,
    });
    if (!prep.ok) return setError(errorText(prep));
    setConsent(prep.data);
    setStep(3);
  };

  const createAndContinue = (confirmed: boolean) =>
    start(async () => {
      setError(null);
      // Hasta zaten oluşturulduysa (ör. belge hazırlığı başarısız olup tekrar denendi) ikinci kayıt AÇILMAZ.
      let current = patient;
      if (!current) {
        if (!confirmed) {
          const dup = await checkDuplicatesAction(values);
          if (dup.ok && dup.data.length) {
            setDuplicates(dup.data);
            return;
          }
        }
        const created = await createPatientAction(values);
        if (!created.ok) return setError(errorText(created));
        current = { id: created.data.id, patientNumber: created.data.patientNumber };
        setPatient(current);
      }
      if (!hasDisclosureTemplate) return prepareConsent(current.id, false);
      const prep = await prepareDocumentAction({
        patientId: current.id,
        type: "KVKK_DISCLOSURE",
        branchId: values.primaryBranchId || undefined,
      });
      if (!prep.ok) return setError(errorText(prep));
      setDisclosure(prep.data);
      setStep(2);
    });

  const toConsent = () =>
    start(async () => {
      setError(null);
      await prepareConsent(patient!.id, true);
    });

  const consentChoices = consent?.snapshot.choices.filter((c) => c.kind === "CONSENT") ?? [];
  const consentComplete = consentChoices.every((c) => !c.required || choices[c.key]);

  const signAll = () =>
    start(async () => {
      setError(null);
      if (!signature) return setError("Lütfen imza atın.");
      const patientName = `${values.firstName ?? ""} ${values.lastName ?? ""}`.trim();
      for (const doc of [disclosure, consent].filter((d): d is DocumentPreview => Boolean(d))) {
        const r = await signDocument(doc, choices, signer, patientName, signature);
        // Tekrar denemede zaten imzalanmış belge atlanır (ilk belge imzalanıp ikincide hata olduysa).
        if (!r.ok && r.code !== "DOCUMENT_ALREADY_SIGNED") return setError(errorText(r));
      }
      setStep(5);
    });

  return (
    <div className="grid gap-6">
      <ol className="grid grid-cols-5 gap-2" aria-label="Adımlar">
        {STEPS.map((s, i) => {
          const n = i + 1;
          const state = n < step ? "done" : n === step ? "current" : "todo";
          return (
            <li
              key={s}
              aria-current={state === "current" ? "step" : undefined}
              className="flex flex-col items-center gap-1 text-center"
            >
              <span
                className={`grid size-9 place-items-center rounded-full text-sm font-semibold ${
                  state === "done"
                    ? "bg-brand-600 text-white"
                    : state === "current"
                      ? "bg-brand-50 text-brand-700 ring-2 ring-brand-600 dark:bg-brand-900 dark:text-brand-100"
                      : "bg-slate-100 text-slate-500 dark:bg-slate-800"
                }`}
              >
                {state === "done" ? "✓" : n}
              </span>
              <span
                className={`hidden text-xs sm:block ${state === "current" ? "font-semibold" : "text-slate-500"}`}
              >
                {s}
              </span>
            </li>
          );
        })}
      </ol>

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      ) : null}

      {step === 1 ? (
        <form
          className="card grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            createAndContinue(false);
          }}
        >
          <h2 className="text-lg font-semibold sm:col-span-2">Hasta bilgileri</h2>
          {(
            [
              ["firstName", "Ad", "text", true],
              ["lastName", "Soyad", "text", true],
              ["phone", "Telefon", "tel", true],
              ["email", "E-posta", "email", false],
              ["birthDate", "Doğum tarihi", "date", false],
            ] as const
          ).map(([k, label, type, required]) => (
            <div key={k}>
              <label htmlFor={`pw-${k}`} className="label">
                {label}
                {required ? <span aria-hidden="true"> *</span> : null}
              </label>
              <input
                id={`pw-${k}`}
                type={type}
                required={required}
                value={values[k] ?? ""}
                onChange={set(k)}
                className="input"
                autoComplete="off"
                inputMode={k === "phone" ? "tel" : undefined}
              />
            </div>
          ))}
          <div>
            <label htmlFor="pw-gender" className="label">
              Cinsiyet
            </label>
            <select id="pw-gender" value={values.gender ?? ""} onChange={set("gender")} className="input">
              <option value="">Belirtilmedi</option>
              <option value="FEMALE">Kadın</option>
              <option value="MALE">Erkek</option>
              <option value="OTHER">Diğer</option>
              <option value="UNDISCLOSED">Belirtmek istemiyor</option>
            </select>
          </div>
          <div>
            <label htmlFor="pw-branch" className="label">
              Ana şube
            </label>
            <select
              id="pw-branch"
              value={values.primaryBranchId ?? ""}
              onChange={set("primaryBranchId")}
              className="input"
            >
              {branches.length > 1 || !defaultBranchId ? <option value="">Seçin</option> : null}
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          {sources.length ? (
            <div>
              <label htmlFor="pw-source" className="label">
                Hasta kaynağı
              </label>
              <select
                id="pw-source"
                value={values.sourceId ?? ""}
                onChange={set("sourceId")}
                className="input"
              >
                <option value="">Belirtilmedi</option>
                {sources.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <label className="flex min-h-11 items-center gap-2 self-end text-sm">
            <input
              type="checkbox"
              checked={values.smsAllowed === "true"}
              onChange={(e) => setValues((v) => ({ ...v, smsAllowed: e.target.checked ? "true" : "false" }))}
            />
            Bilgilendirme SMS’i gönderilebilir
          </label>
          <details className="panel sm:col-span-2">
            <summary className="cursor-pointer text-sm font-medium text-brand-700">
              Ek bilgiler (isteğe bağlı)
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="pw-socialSecurity" className="label">
                  Sosyal güvence
                </label>
                <select
                  id="pw-socialSecurity"
                  value={values.socialSecurity ?? ""}
                  onChange={set("socialSecurity")}
                  className="input"
                >
                  <option value="">Belirtilmedi</option>
                  {SOCIAL_SECURITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              {insurers.length ? (
                <div>
                  <label htmlFor="pw-insurer" className="label">
                    Özel sigorta
                  </label>
                  <select
                    id="pw-insurer"
                    value={values.insurerId ?? ""}
                    onChange={set("insurerId")}
                    className="input"
                  >
                    <option value="">Yok</option>
                    {insurers.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {(
                [
                  ["secondaryPhone", "İkinci telefon", "tel"],
                  ["nationalId", "TC kimlik no (şifreli saklanır)", "text"],
                  ["address", "Adres", "text"],
                  ["city", "Şehir", "text"],
                  ["district", "İlçe", "text"],
                  ["emergencyContactName", "Acil durumda aranacak kişi", "text"],
                  ["emergencyContactPhone", "Acil durum telefonu", "tel"],
                  ["referral", "Yönlendiren (kişi / kurum)", "text"],
                ] as const
              ).map(([k, label, type]) => (
                <div key={k}>
                  <label htmlFor={`pw-${k}`} className="label">
                    {label}
                  </label>
                  <input
                    id={`pw-${k}`}
                    type={type}
                    value={values[k] ?? ""}
                    onChange={set(k)}
                    className="input"
                    autoComplete="off"
                    inputMode={k === "nationalId" ? "numeric" : undefined}
                  />
                </div>
              ))}
            </div>
          </details>

          {duplicates?.length ? (
            <div
              role="alert"
              className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm sm:col-span-2 dark:border-amber-900 dark:bg-amber-950"
            >
              <p className="font-semibold text-amber-900 dark:text-amber-200">Benzer hasta kaydı olabilir</p>
              <p className="mt-1 text-amber-800 dark:text-amber-300">
                Kayıtlar otomatik birleştirilmez. Mevcut kaydı açabilir veya yine de yeni kayıt
                oluşturabilirsiniz.
              </p>
              <ul className="mt-3 grid gap-1">
                {duplicates.map((d) => (
                  <li key={d.id}>
                    <Link href={`/patients/${d.id}`} className="font-medium underline">
                      {d.patientNumber} · {d.firstName} {d.lastName}
                    </Link>{" "}
                    <span className="text-amber-700 dark:text-amber-400">
                      (
                      {d.matchedOn
                        .map((m) =>
                          m === "PHONE" ? "telefon" : m === "EMAIL" ? "e-posta" : "ad + doğum tarihi",
                        )
                        .join(", ")}
                      )
                    </span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn-ghost mt-3"
                disabled={pending}
                onClick={() => createAndContinue(true)}
              >
                Yine de yeni kayıt oluştur
              </button>
            </div>
          ) : null}

          <div className="sm:col-span-2">
            <button type="submit" className="btn min-h-12 px-8" disabled={pending}>
              {pending ? "Kaydediliyor…" : patient ? "Tekrar dene" : "Devam et"}
            </button>
          </div>
        </form>
      ) : null}

      {step === 2 && disclosure ? (
        <div className="card grid gap-4">
          <DocumentHeader doc={disclosure} />
          <DocumentBody text={disclosure.snapshot.content} />
          <label className="flex min-h-12 items-center gap-3 rounded-xl border border-slate-200 p-3 text-base dark:border-slate-700">
            <input
              type="checkbox"
              checked={informed}
              onChange={(e) => setInformed(e.target.checked)}
              className="size-6"
            />
            Aydınlatma metnini okudum ve bilgilendirildim.
          </label>
          <p className="hint">Bu bir rıza beyanı değildir; yalnızca bilgilendirildiğinizi gösterir.</p>
          <div>
            <button
              type="button"
              className="btn min-h-12 px-8"
              disabled={!informed || pending}
              onClick={toConsent}
            >
              {pending ? "Hazırlanıyor…" : "Devam et"}
            </button>
          </div>
        </div>
      ) : null}

      {step === 3 && consent ? (
        <div className="card grid gap-4">
          <DocumentHeader doc={consent} />
          <DocumentBody text={consent.snapshot.content} />
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Her tercih ayrıdır. Onay vermemeniz sağlık hizmeti almanızı etkilemez.
          </p>
          <ConsentChoices
            choices={consentChoices}
            values={choices}
            onChange={(k, v) => setChoices((x) => ({ ...x, [k]: v }))}
          />
          <div>
            <button
              type="button"
              className="btn min-h-12 px-8"
              disabled={!consentComplete}
              onClick={() => setStep(4)}
            >
              Devam et
            </button>
          </div>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="card grid gap-5">
          <h2 className="text-lg font-semibold">İmza</h2>
          <ul className="grid gap-2 text-sm">
            {[disclosure, consent].filter(Boolean).map((d) => (
              <li
                key={d!.documentId}
                className="flex flex-wrap justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800"
              >
                <span className="font-medium">{d!.snapshot.title}</span>
                <span className="text-slate-500">
                  {d!.snapshot.name} · v{d!.snapshot.version}
                </span>
              </li>
            ))}
          </ul>
          <SignerFields signer={signer} onChange={setSigner} />
          <p className="rounded-xl bg-brand-50 px-4 py-3 text-sm font-medium text-brand-900 dark:bg-brand-900 dark:text-brand-50">
            {SIGNATURE_STATEMENT}
          </p>
          <SignaturePad onChange={setSignature} label="Hasta imza alanı" />
          <div>
            <button
              type="button"
              className="btn min-h-14 px-10 text-base"
              disabled={!signature || pending || !signerReady(signer)}
              onClick={signAll}
            >
              {pending ? "İmzalanıyor…" : "İmzala"}
            </button>
          </div>
        </div>
      ) : null}

      {step === 5 && patient ? (
        <div className="card grid justify-items-center gap-4 py-10 text-center">
          <span className="grid size-16 place-items-center rounded-full bg-emerald-50 text-3xl text-emerald-700 dark:bg-emerald-950">
            ✓
          </span>
          <h2 className="text-xl font-semibold">Kayıt tamamlandı</h2>
          <p className="text-slate-600 dark:text-slate-400">
            Hasta no <span className="font-mono font-semibold">{patient.patientNumber}</span> · belgeler
            imzalandı ve güvenli şekilde saklandı.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href={`/patients/${patient.id}`} className="btn">
              Hasta dosyasını aç
            </Link>
            <Link href="/patients/new" className="btn-ghost">
              Yeni hasta
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
