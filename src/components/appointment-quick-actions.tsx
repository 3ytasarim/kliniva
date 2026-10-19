"use client";

import { useActionState } from "react";
import { Check, Play, UserCheck, UserX } from "lucide-react";
import { appointmentStatusAction, startExaminationAction } from "@/app/actions/appointments";
import { Button } from "@/components/ui/button";
import type { QuickAction, QuickActionKey } from "@/components/appointment-ui";
import { cn } from "@/lib/cn";

type State = { ok: boolean; message?: string } | null;

const STATUS: Record<Exclude<QuickActionKey, "start-exam">, string> = {
  checkin: "CHECKED_IN",
  start: "IN_PROGRESS",
  complete: "COMPLETED",
  "no-show": "NO_SHOW",
};
const ICON: Record<QuickActionKey, typeof Check> = {
  "start-exam": Play,
  checkin: UserCheck,
  start: Play,
  complete: Check,
  "no-show": UserX,
};

/** Tek hızlı işlem düğmesi (sunucu eylemi; sonuç başarılıysa onDone). Sunucu her geçişi yeniden doğrular. */
function QuickActionButton({
  id,
  action,
  onDone,
  size,
}: {
  id: string;
  action: QuickAction;
  onDone?: (message: string) => void;
  size: "sm" | "default";
}) {
  const server = action.key === "start-exam" ? startExaminationAction : appointmentStatusAction;
  const [state, formAction, pending] = useActionState(async (prev: State, form: FormData): Promise<State> => {
    const r = (await server(prev, form)) as State;
    if (r?.ok) onDone?.(r.message ?? "");
    return r;
  }, null);
  const Icon = ICON[action.key];
  return (
    <form
      action={formAction}
      className="inline-flex flex-col items-start gap-1"
      onSubmit={(e) => {
        if (action.key === "no-show" && !window.confirm("Hasta 'gelmedi' olarak işaretlensin mi?"))
          e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      {action.key !== "start-exam" ? <input type="hidden" name="status" value={STATUS[action.key]} /> : null}
      <Button
        type="submit"
        size={size}
        variant={action.variant === "primary" ? "default" : "outline"}
        className={cn(
          action.variant === "danger" &&
            "border-red-200 text-red-700 hover:border-red-300 hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10",
        )}
        disabled={pending}
        aria-busy={pending}
      >
        <Icon />
        {pending ? "…" : action.label}
      </Button>
      {state && !state.ok && state.message ? (
        <span role="alert" className="text-xs text-red-700 dark:text-red-400">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

export function QuickActionButtons({
  id,
  actions,
  onDone,
  size = "sm",
  className,
}: {
  id: string;
  actions: QuickAction[];
  onDone?: (message: string) => void;
  size?: "sm" | "default";
  className?: string;
}) {
  if (!actions.length) return null;
  return (
    <div className={cn("flex flex-wrap items-start gap-2", className)}>
      {actions.map((a) => (
        <QuickActionButton key={a.key} id={id} action={a} onDone={onDone} size={size} />
      ))}
    </div>
  );
}
