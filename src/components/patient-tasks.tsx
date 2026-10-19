import Link from "next/link";
import { CalendarClock, Mail, MessageSquare, Phone, PhoneIncoming, Users } from "lucide-react";
import { ActionForm, Field, SelectField } from "@/components/action-form";
import { EmptyState } from "@/components/ui";
import { closeTaskAction, createTaskAction } from "@/app/actions/tasks";
import { cn } from "@/lib/cn";
import {
  TASK_STATUS_LABELS,
  TASK_TYPES,
  TASK_TYPE_LABELS,
  type PatientTaskItem,
  type TaskType,
} from "@/types/tasks";

/**
 * Hasta görevleri — liste (kapatma formuyla) ve yeni görev formu. Sunucu bileşeni; yetki sunucuda tekrar doğrulanır.
 */
const TYPE_ICON: Record<TaskType, typeof Phone> = {
  OUTGOING_CALL: Phone,
  INCOMING_CALL: PhoneIncoming,
  EMAIL: Mail,
  SMS: MessageSquare,
  MEETING: Users,
  OTHER: CalendarClock,
};

const dueFmt = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function TaskList({
  tasks,
  showPatient = true,
  empty = "Görev yok",
}: {
  tasks: PatientTaskItem[];
  showPatient?: boolean;
  empty?: string;
}) {
  if (!tasks.length) return <EmptyState title={empty} icon="check" />;
  return (
    <ul className="grid gap-2" data-testid="task-list">
      {tasks.map((t) => {
        const Icon = TYPE_ICON[t.taskType];
        const closed = t.status !== "OPEN";
        return (
          <li
            key={t.id}
            data-testid="task-row"
            className={cn(
              "rounded-xl border border-line p-3 dark:border-line-dark",
              t.overdue && "border-red-200 bg-red-50/40 dark:border-red-500/30 dark:bg-red-500/5",
              closed && "opacity-75",
            )}
          >
            <div className="flex flex-wrap items-start gap-3">
              <span
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-lg",
                  t.overdue
                    ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"
                    : "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-medium", closed && "line-through")}>{t.title}</p>
                <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-slate-500 dark:text-slate-400">
                  <span className={cn(t.overdue && "font-semibold text-red-700 dark:text-red-400")}>
                    {dueFmt.format(new Date(t.dueAt))}
                    {t.overdue ? " · gecikti" : ""}
                  </span>
                  <span>· {TASK_TYPE_LABELS[t.taskType]}</span>
                  {showPatient ? (
                    <span>
                      ·{" "}
                      <Link href={`/patients/${t.patientId}?tab=tasks`} className="hover:text-brand-700">
                        {t.patientName}
                      </Link>
                    </span>
                  ) : null}
                  <span>· Atanan: {t.assigneeName}</span>
                </p>
                {t.notes ? (
                  <p className="mt-1 whitespace-pre-line text-xs text-slate-600 dark:text-slate-300">
                    {t.notes}
                  </p>
                ) : null}
                {closed ? (
                  <p className="mt-1 text-xs">
                    <span
                      className={cn(
                        "badge",
                        t.status === "DONE"
                          ? "badge-green"
                          : t.status === "UNREACHABLE"
                            ? "badge-amber"
                            : "badge-gray",
                      )}
                    >
                      {TASK_STATUS_LABELS[t.status]}
                    </span>{" "}
                    <span className="text-slate-500">{t.completedByName}</span>
                    {t.result ? <span className="mt-1 block whitespace-pre-line">{t.result}</span> : null}
                  </p>
                ) : null}
              </div>
              {!closed ? (
                <span className="badge badge-sky shrink-0">{TASK_STATUS_LABELS[t.status]}</span>
              ) : null}
            </div>
            {t.canUpdate ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-brand-700 dark:text-brand-300">
                  Sonuçlandır
                </summary>
                <ActionForm
                  action={closeTaskAction}
                  submitLabel="Kaydet"
                  className="mt-2 grid gap-2 sm:grid-cols-[12rem_1fr]"
                >
                  <input type="hidden" name="id" value={t.id} />
                  <input type="hidden" name="patientId" value={t.patientId} />
                  <SelectField
                    label="Sonuç"
                    name="status"
                    defaultValue="DONE"
                    options={[
                      { value: "DONE", label: "Tamamlandı" },
                      { value: "UNREACHABLE", label: "Ulaşılamadı" },
                      { value: "CANCELLED", label: "İptal" },
                    ]}
                    idPrefix={`tc-${t.id.slice(0, 8)}`}
                  />
                  <Field
                    label="Not (isteğe bağlı)"
                    name="result"
                    maxLength={1000}
                    idPrefix={`tc-${t.id.slice(0, 8)}`}
                  />
                </ActionForm>
              </details>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function NewTaskForm({
  patientId,
  appointmentId,
  assignees,
  currentUserId,
  defaultDate,
}: {
  patientId: string;
  appointmentId?: string;
  assignees: { id: string; name: string }[];
  currentUserId: string;
  defaultDate: string;
}) {
  return (
    <ActionForm
      action={createTaskAction}
      submitLabel="Görevi oluştur"
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <input type="hidden" name="patientId" value={patientId} />
      {appointmentId ? <input type="hidden" name="appointmentId" value={appointmentId} /> : null}
      <SelectField
        label="Tür"
        name="taskType"
        required
        defaultValue="OUTGOING_CALL"
        options={TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABELS[t] }))}
        idPrefix="nt"
      />
      <Field
        label="Başlık"
        name="title"
        required
        minLength={3}
        maxLength={160}
        placeholder="örn. Kontrol randevusu için ara"
        idPrefix="nt"
        className="sm:col-span-1 lg:col-span-3"
      />
      <Field label="Tarih" name="dueDate" type="date" required defaultValue={defaultDate} idPrefix="nt" />
      <Field label="Saat" name="dueTime" type="time" required defaultValue="10:00" idPrefix="nt" />
      <SelectField
        label="Atanan"
        name="assigneeUserId"
        required
        defaultValue={assignees.some((a) => a.id === currentUserId) ? currentUserId : assignees[0]?.id}
        options={assignees.map((a) => ({
          value: a.id,
          label: a.id === currentUserId ? `${a.name} (ben)` : a.name,
        }))}
        idPrefix="nt"
      />
      <Field label="Not" name="notes" maxLength={1000} idPrefix="nt" />
    </ActionForm>
  );
}
