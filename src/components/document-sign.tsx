"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SignaturePad } from "@/components/signature-pad";
import { CONSENT_LABELS } from "@/components/patient-ui";
import { signDocumentAction, type DataResult } from "@/app/actions/patients";
import type { DocumentPreview } from "@/types/patients";

/**
 * Belge imzalama yapı taşları — hem yeni hasta sihirbazı hem tablet odak ekranı kullanır.
 * Önizlenen içerik sunucudaki değişmez snapshot'tır; imzada önizlenen contentSha256 geri gönderilir (TOCTOU).
 */
export type ConsentValue = "GRANTED" | "DENIED";
export type SignerType = "PATIENT" | "PARENT" | "LEGAL_GUARDIAN";
export type Signer = { type: SignerType; guardianName: string; relationship: string };
type Choice = DocumentPreview["snapshot"]["choices"][number];

export const SIGNATURE_STATEMENT = "Bu imza, yukarıda görüntülenen belgenin bu sürümüne aittir.";

export function resultMessage(
  r: Extract<DataResult<unknown>, { ok: false }>,
  labels: Record<string, string> = {},
) {
  const fields = r.fields?.map((f) => labels[f] ?? f).join(", ");
  return fields ? `${r.message} (${fields})` : r.message;
}

export function DocumentHeader({ doc }: { doc: DocumentPreview }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-lg font-semibold">{doc.snapshot.title}</h2>
      <span className="badge badge-gray">
        {doc.snapshot.name} · v{doc.snapshot.version}
      </span>
    </div>
  );
}

export function DocumentBody({ text }: { text: string }) {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="Belge metni"
      className="max-h-[45vh] overflow-y-auto whitespace-pre-line rounded-xl border border-slate-200 bg-slate-50 p-5 text-base leading-relaxed dark:border-slate-700 dark:bg-slate-900"
    >
      {text}
    </div>
  );
}

/** Her açık rıza seçeneği ayrı ve bağımsız; Onaylıyorum / Onaylamıyorum (önceden işaretli DEĞİL). */
export function ConsentChoices({
  choices,
  values,
  onChange,
}: {
  choices: Choice[];
  values: Record<string, ConsentValue>;
  onChange: (key: string, v: ConsentValue) => void;
}) {
  return (
    <div className="grid gap-3">
      {choices.map((c) => (
        <fieldset key={c.key} className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          <legend className="px-1 font-medium">{c.label || CONSENT_LABELS[c.key] || c.key}</legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {(
              [
                ["GRANTED", "Onaylıyorum"],
                ["DENIED", "Onaylamıyorum"],
              ] as const
            ).map(([v, l]) => (
              <label
                key={v}
                className={`flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border px-4 text-base ${
                  values[c.key] === v
                    ? "border-brand-600 bg-brand-50 dark:bg-brand-900"
                    : "border-slate-200 dark:border-slate-700"
                }`}
              >
                <input
                  type="radio"
                  name={`c-${c.key}`}
                  value={v}
                  checked={values[c.key] === v}
                  onChange={() => onChange(c.key, v)}
                  className="size-5"
                />
                {l}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

/** Hasta mı, yasal temsilci mi imzalıyor? Yaş kuralı kodlanmaz; karar personeldedir. */
export function SignerFields({ signer, onChange }: { signer: Signer; onChange: (s: Signer) => void }) {
  const guardian = signer.type !== "PATIENT";
  return (
    <fieldset className="grid gap-3">
      <legend className="label">İmzalayan</legend>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={guardian}
          onChange={(e) => onChange({ ...signer, type: e.target.checked ? "LEGAL_GUARDIAN" : "PATIENT" })}
          className="size-5"
        />
        Hasta yerine yasal temsilci imzalıyor
      </label>
      {guardian ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="sg-type" className="label">
              Temsil türü
            </label>
            <select
              id="sg-type"
              value={signer.type}
              onChange={(e) => onChange({ ...signer, type: e.target.value as SignerType })}
              className="input"
            >
              <option value="PARENT">Veli</option>
              <option value="LEGAL_GUARDIAN">Yasal temsilci</option>
            </select>
          </div>
          <div>
            <label htmlFor="sg-name" className="label">
              Temsilci adı soyadı
            </label>
            <input
              id="sg-name"
              value={signer.guardianName}
              onChange={(e) => onChange({ ...signer, guardianName: e.target.value })}
              className="input"
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor="sg-rel" className="label">
              Yakınlık
            </label>
            <input
              id="sg-rel"
              value={signer.relationship}
              onChange={(e) => onChange({ ...signer, relationship: e.target.value })}
              placeholder="Anne, Baba, Vasi…"
              className="input"
              autoComplete="off"
            />
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}

export const signerReady = (s: Signer) =>
  s.type === "PATIENT" || (s.guardianName.trim().length > 1 && s.relationship.trim().length > 1);

/** Snapshot seçimlerinden sunucuya gidecek değerler: ACKNOWLEDGEMENT → READ_AND_INFORMED, CONSENT → seçilen. */
export function choicesPayload(doc: DocumentPreview, consent: Record<string, ConsentValue>) {
  const out: Record<string, "READ_AND_INFORMED" | ConsentValue> = {};
  for (const c of doc.snapshot.choices) {
    if (c.kind === "ACKNOWLEDGEMENT") out[c.key] = "READ_AND_INFORMED";
    else if (consent[c.key]) out[c.key] = consent[c.key]!;
  }
  return out;
}

export function signDocument(
  doc: DocumentPreview,
  consent: Record<string, ConsentValue>,
  signer: Signer,
  patientName: string,
  signaturePng: string,
) {
  return signDocumentAction({
    documentId: doc.documentId,
    signaturePng,
    choices: choicesPayload(doc, consent),
    signedByName: signer.type === "PATIENT" ? patientName : signer.guardianName.trim(),
    signerType: signer.type,
    guardianRelationship: signer.type === "PATIENT" ? undefined : signer.relationship.trim(),
    expectedContentSha256: doc.contentSha256,
  });
}

/** Tablet odak ekranı: tek belge — metin, seçimler, imzalayan, beyan, imza alanı. */
export function DocumentSignForm({ doc, returnHref }: { doc: DocumentPreview; returnHref: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [informed, setInformed] = useState(false);
  const [consent, setConsent] = useState<Record<string, ConsentValue>>({});
  const [signer, setSigner] = useState<Signer>({ type: "PATIENT", guardianName: "", relationship: "" });
  const [signature, setSignature] = useState<string | null>(null);

  const acks = doc.snapshot.choices.filter((c) => c.kind === "ACKNOWLEDGEMENT");
  const consents = doc.snapshot.choices.filter((c) => c.kind === "CONSENT");
  const ready =
    (acks.length === 0 || informed) &&
    consents.every((c) => !c.required || consent[c.key]) &&
    signerReady(signer) &&
    Boolean(signature);

  const submit = () =>
    start(async () => {
      setError(null);
      const r = await signDocument(doc, consent, signer, doc.patientName, signature!);
      if (!r.ok) return setError(resultMessage(r));
      router.push(returnHref);
      router.refresh();
    });

  return (
    <div className="grid gap-5">
      <div className="card grid gap-4">
        <DocumentHeader doc={doc} />
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {doc.patientName} · <span className="font-mono">{doc.patientNumber}</span>
        </p>
        <DocumentBody text={doc.snapshot.content} />
        {acks.length ? (
          <label className="flex min-h-12 items-center gap-3 rounded-xl border border-slate-200 p-3 text-base dark:border-slate-700">
            <input
              type="checkbox"
              checked={informed}
              onChange={(e) => setInformed(e.target.checked)}
              className="size-6"
            />
            {acks[0]!.label || "Aydınlatma metnini okudum ve bilgilendirildim."}
          </label>
        ) : null}
        {consents.length ? (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Her tercih ayrıdır. Onay vermemeniz sağlık hizmeti almanızı etkilemez.
            </p>
            <ConsentChoices
              choices={consents}
              values={consent}
              onChange={(k, v) => setConsent((x) => ({ ...x, [k]: v }))}
            />
          </>
        ) : null}
      </div>

      <div className="card grid gap-5">
        <SignerFields signer={signer} onChange={setSigner} />
        <p className="rounded-xl bg-brand-50 px-4 py-3 text-sm font-medium text-brand-900 dark:bg-brand-900 dark:text-brand-50">
          {SIGNATURE_STATEMENT}
        </p>
        <SignaturePad onChange={setSignature} label="İmza alanı" />
        {error ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <div>
          <button
            type="button"
            className="btn min-h-14 px-10 text-base"
            disabled={!ready || pending}
            onClick={submit}
          >
            {pending ? "İmzalanıyor…" : "İmzala"}
          </button>
        </div>
      </div>
    </div>
  );
}
