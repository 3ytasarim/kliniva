import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { getMyTaskCounts, listTasks } from "@/server/services/tasks";
import { Forbidden } from "@/components/forbidden";
import { PageHeader, SectionCard, StatCard } from "@/components/ui";
import { TaskList } from "@/components/patient-tasks";
import { cn } from "@/lib/cn";
import type { TaskScope, TaskView } from "@/types/tasks";

export const metadata: Metadata = { title: "Görevler" };

const VIEWS: { key: TaskView; label: string }[] = [
  { key: "open", label: "Açık" },
  { key: "overdue", label: "Geciken" },
  { key: "today", label: "Bugün" },
  { key: "done", label: "Kapanan" },
];

/**
 * Görevler — bana atananlar (herkes) ve şubedeki tüm görevler (task.manage). Yeni görev hasta dosyasının
 * "Görevler" sekmesinden açılır (görev her zaman bir hastaya bağlıdır).
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; view?: string }>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "task.read")) return <Forbidden />;
  const sp = await searchParams;
  const canAll = hasPermission(ctx, "task.manage");
  const scope: TaskScope = sp.scope === "all" && canAll ? "all" : "mine";
  const view = VIEWS.find((v) => v.key === sp.view)?.key ?? "open";
  const [tasks, counts] = await Promise.all([listTasks(ctx, { scope, view }), getMyTaskCounts(ctx)]);
  const href = (s: TaskScope, v: TaskView) => `/tasks?${s === "all" ? "scope=all&" : ""}view=${v}`;

  return (
    <section className="grid gap-6">
      <PageHeader
        title="Görevler"
        description="Hasta arama, e-posta ve görüşme hatırlatmaları. Yeni görev hasta dosyasının Görevler sekmesinden eklenir."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Bana atanan açık"
          value={counts.open}
          icon="check"
          tone="brand"
          href={href("mine", "open")}
        />
        <StatCard
          label="Geciken"
          value={counts.overdue}
          icon="alert"
          tone={counts.overdue ? "red" : "slate"}
          href={href("mine", "overdue")}
        />
        <StatCard label="Bugün" value={counts.today} icon="clock" tone="amber" href={href("mine", "today")} />
      </div>
      <SectionCard
        title={scope === "all" ? "Şubedeki tüm görevler" : "Bana atanan görevler"}
        description={`${tasks.length} görev`}
        action={
          canAll ? (
            <nav aria-label="Kapsam" className="inline-flex rounded-lg bg-slate-100 p-0.5 dark:bg-white/5">
              {(
                [
                  ["mine", "Bana atanan"],
                  ["all", "Tümü"],
                ] as const
              ).map(([k, l]) => (
                <Link
                  key={k}
                  href={href(k, view)}
                  aria-current={scope === k ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium",
                    scope === k
                      ? "bg-white text-slate-900 shadow-[0_1px_2px_rgb(16_24_40/0.08)] dark:bg-raised-dark dark:text-white"
                      : "text-slate-500 hover:text-slate-900 dark:text-slate-400",
                  )}
                >
                  {l}
                </Link>
              ))}
            </nav>
          ) : null
        }
      >
        <nav aria-label="Görünüm" className="mb-4 flex flex-wrap gap-2">
          {VIEWS.map((v) => (
            <Link
              key={v.key}
              href={href(scope, v.key)}
              aria-current={view === v.key ? "page" : undefined}
              className={cn(
                "inline-flex min-h-9 items-center rounded-full border px-3.5 text-[13px] font-medium",
                view === v.key
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-line text-slate-600 hover:border-brand-300 dark:border-line-dark dark:text-slate-300",
              )}
            >
              {v.label}
            </Link>
          ))}
        </nav>
        <TaskList
          tasks={tasks}
          empty={view === "done" ? "Kapanan görev yok" : "Bu görünümde açık görev yok"}
        />
      </SectionCard>
    </section>
  );
}
