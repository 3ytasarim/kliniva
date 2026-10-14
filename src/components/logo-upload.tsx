"use client";

import { useActionState, useState } from "react";

type State = { ok: boolean; message?: string; fields?: string[] } | null;

/**
 * Logo yükleme: seçilen dosyanın YEREL önizlemesi (blob: URL, sunucuya gitmeden) + yükleme.
 * İstemci tarafı kontroller yalnızca kullanım kolaylığıdır; asıl doğrulama (magic bytes + decode + 5 MB) sunucuda.
 */
export function LogoUpload({
  action,
  hasLogo,
}: {
  action: (prev: State, form: FormData) => Promise<State>;
  hasLogo: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [preview, setPreview] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-5">
      <div className="grid size-28 place-items-center overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Seçilen logo önizlemesi" className="size-full object-contain p-2" />
        ) : hasLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src="/api/v1/clinic/logo"
            alt="Mevcut klinik logosu"
            className="size-full object-contain p-2"
          />
        ) : (
          <span className="text-xs text-slate-400">Logo yok</span>
        )}
      </div>
      <div className="grid gap-2">
        <label htmlFor="logo" className="label">
          Klinik logosu
        </label>
        <input
          id="logo"
          name="logo"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-700"
          onChange={(e) => {
            const f = e.target.files?.[0];
            setClientError(null);
            if (preview) URL.revokeObjectURL(preview);
            if (!f) return setPreview(null);
            if (f.size > 5 * 1024 * 1024) setClientError("Logo en fazla 5 MB olabilir.");
            setPreview(URL.createObjectURL(f));
          }}
        />
        <p className="hint">PNG, JPEG veya WEBP · en fazla 5 MB · SVG desteklenmez.</p>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-sm" disabled={pending || Boolean(clientError)}>
            {pending ? "Yükleniyor…" : "Logoyu yükle"}
          </button>
          {clientError || state?.message ? (
            <span
              role={clientError || !state?.ok ? "alert" : "status"}
              className={`text-sm ${clientError || !state?.ok ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}
            >
              {clientError ?? state?.message}
            </span>
          ) : null}
        </div>
      </div>
    </form>
  );
}
