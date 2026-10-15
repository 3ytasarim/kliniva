"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { prepareDocumentAction } from "@/app/actions/patients";
import { resultMessage } from "@/components/document-sign";

/**
 * Yeni belge: yayımlanmış şablondan DEĞİŞMEZ snapshot oluşturur + sunar, ardından tablet imza ekranına geçer.
 * (GET ile belge oluşturulmaz — yan etki yalnızca bu açık kullanıcı eylemiyle olur.)
 */
export function NewDocumentButton({
  patientId,
  types,
}: {
  patientId: string;
  types: { type: string; label: string }[];
}) {
  const router = useRouter();
  const [type, setType] = useState(types[0]?.type ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!types.length) return <p className="hint">Yayımlanmış belge şablonu yok.</p>;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor="nd-type" className="label">
          Yeni belge
        </label>
        <select id="nd-type" value={type} onChange={(e) => setType(e.target.value)} className="input">
          {types.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="btn"
        disabled={pending || !type}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await prepareDocumentAction({ patientId, type });
            if (!r.ok) return setError(resultMessage(r));
            router.push(`/patients/${patientId}/documents/sign?doc=${r.data.documentId}`);
          })
        }
      >
        {pending ? "Hazırlanıyor…" : "İmzaya hazırla"}
      </button>
      {error ? (
        <p role="alert" className="w-full text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
