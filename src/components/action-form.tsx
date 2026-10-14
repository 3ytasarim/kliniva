"use client";

import { useActionState } from "react";

type State = { ok: boolean; message?: string; fields?: string[] } | null;

/** Server Action formu: bekleme durumu + erişilebilir sonuç mesajı (role=status / role=alert). */
export function ActionForm({
  action,
  submitLabel,
  children,
  className,
}: {
  action: (prev: State, form: FormData) => Promise<State>;
  submitLabel: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className={className ?? "grid gap-4"} noValidate>
      {children}
      {state?.message ? (
        <p
          role={state.ok ? "status" : "alert"}
          className={
            state.ok
              ? "text-sm text-emerald-700 dark:text-emerald-400"
              : "text-sm text-red-700 dark:text-red-400"
          }
        >
          {state.message}
          {state.fields?.length ? ` (${state.fields.join(", ")})` : null}
        </p>
      ) : null}
      <div>
        <button type="submit" className="btn" disabled={pending} aria-busy={pending}>
          {pending ? "İşleniyor…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * Etiketli input. Aynı sayfada aynı alan adına sahip birden çok form olabileceği için `idPrefix` ile benzersiz id.
 */
export function Field({
  label,
  name,
  required,
  idPrefix = "f",
  hint,
  className,
  ...input
}: {
  label: string;
  name: string;
  required?: boolean;
  idPrefix?: string;
  hint?: string;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "name" | "id" | "className">) {
  const id = `${idPrefix}-${name}`;
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        name={name}
        required={required}
        className="input"
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...input}
      />
      {hint ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function SelectField({
  label,
  name,
  options,
  defaultValue,
  required,
  idPrefix = "f",
  className,
  placeholder,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
  required?: boolean;
  idPrefix?: string;
  className?: string;
  placeholder?: string;
}) {
  const id = `${idPrefix}-${name}`;
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <select id={id} name={name} required={required} defaultValue={defaultValue ?? ""} className="input">
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Tek düğmelik satır içi işlem (pasifleştir, sil…). Gizli alanlar `fields` ile verilir; sonuç düğmenin yanında. */
export function InlineAction({
  action,
  fields,
  label,
  variant = "ghost",
  confirm,
}: {
  action: (prev: State, form: FormData) => Promise<State>;
  fields: Record<string, string>;
  label: string;
  variant?: "ghost" | "danger" | "primary";
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const cls = variant === "danger" ? "btn-danger" : variant === "primary" ? "btn btn-sm" : "btn-ghost btn-sm";
  return (
    <form
      action={formAction}
      className="inline-flex items-center gap-2"
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" className={cls} disabled={pending} aria-busy={pending}>
        {pending ? "…" : label}
      </button>
      {state && !state.ok && state.message ? (
        <span role="alert" className="text-xs text-red-700 dark:text-red-400">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
