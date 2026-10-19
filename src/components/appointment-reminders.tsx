"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellRing, ChevronDown, ChevronUp, Clock3, X } from "lucide-react";
import { Avatar } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { QuickActionButtons } from "@/components/appointment-quick-actions";
import { NOTIFICATION_EVENT } from "@/components/notification-bell";
import type { AppointmentReminder } from "@/types/reminders";
import { cn } from "@/lib/cn";

/**
 * SAATİ GELEN RANDEVU KARTI — randevu saati gelince (ve muayene süresi aşılınca) sağ üstte kendiliğinden açılır;
 * hastayı ve yapılabilecek işlemleri gösterir (Hasta geldi / Muayeneyi başlat / Tamamla / Gelmedi). Engelleyici DEĞİL
 * (arka plan örtüsü yok, sayfa kullanılmaya devam eder). Ertele: 10 dk; "Bugün sessize al": yalnızca bu tarayıcıda.
 * Veri: /api/v1/appointments/reminders (kapsam ve yetki sunucuda). 45 sn'de bir + gerçek zamanlı bildirimde yenilenir.
 */
const POLL_MS = 45_000;
const SNOOZE_MS = 10 * 60_000;
const MUTE_KEY = "kliniva:reminders-muted-until";
const SNOOZE_KEY = "kliniva:reminders-snoozed";

const KIND_TEXT: Record<AppointmentReminder["kind"], string> = {
  due: "Randevu saati geldi — hasta geldi mi?",
  waiting: "Hasta geldi, muayene bekliyor",
  overdue: "Muayene süresi doldu — tamamlandı mı?",
};

const todayKey = () => new Date().toLocaleDateString("en-CA");
const nowMs = () => Date.now();
function readMuted(): boolean {
  try {
    const v = localStorage.getItem(MUTE_KEY);
    return Boolean(v && v >= todayKey());
  } catch {
    return false;
  }
}
function readSnoozed(): Record<string, number> {
  try {
    return JSON.parse(sessionStorage.getItem(SNOOZE_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
function writeSnoozed(v: Record<string, number>) {
  try {
    sessionStorage.setItem(SNOOZE_KEY, JSON.stringify(v));
  } catch {
    /* depolama kapalıysa yalnızca bellekte */
  }
}

export function AppointmentReminders() {
  const router = useRouter();
  const [items, setItems] = useState<AppointmentReminder[]>([]);
  const [snoozed, setSnoozed] = useState<Record<string, number>>({});
  const [muted, setMuted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/appointments/reminders", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { data: AppointmentReminder[] };
      setItems(body.data);
      setNow(nowMs());
    } catch {
      /* ağ hatası: bir sonraki turda yeniden denenir */
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => {
      setMuted(readMuted());
      setSnoozed(readSnoozed());
      void load();
    }, 0);
    const poll = setInterval(() => void load(), POLL_MS);
    const onSignal = () => void load();
    window.addEventListener(NOTIFICATION_EVENT, onSignal);
    document.addEventListener("visibilitychange", onSignal);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
      window.removeEventListener(NOTIFICATION_EVENT, onSignal);
      document.removeEventListener("visibilitychange", onSignal);
    };
  }, [load]);

  const visible = muted ? [] : items.filter((i) => !((snoozed[`${i.id}:${i.kind}`] ?? 0) > now));
  if (!visible.length) return null;

  const snooze = (r: AppointmentReminder) => {
    const next = { ...snoozed, [`${r.id}:${r.kind}`]: nowMs() + SNOOZE_MS };
    setSnoozed(next);
    writeSnoozed(next);
  };
  const muteToday = () => {
    try {
      localStorage.setItem(MUTE_KEY, todayKey());
    } catch {
      /* yalnızca bu oturum */
    }
    setMuted(true);
  };

  return (
    <section
      aria-label="Saati gelen randevular"
      aria-live="polite"
      className="animate-slide-in fixed right-4 top-20 z-40 w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-raised dark:border-brand-500/30 dark:bg-raised-dark"
    >
      <header className="flex items-center gap-3 bg-gradient-to-r from-brand-600 to-brand-700 px-4 py-3 text-white">
        <span className="relative grid size-8 place-items-center rounded-lg bg-white/15">
          <span aria-hidden="true" className="absolute inset-0 animate-ping rounded-lg bg-white/20" />
          <BellRing className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Saati gelen randevular</p>
          <p className="text-xs text-brand-100">{visible.length} randevu işlem bekliyor</p>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="grid size-8 place-items-center rounded-md text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          aria-label={collapsed ? "Genişlet" : "Daralt"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        </button>
        <button
          type="button"
          onClick={muteToday}
          className="grid size-8 place-items-center rounded-md text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          aria-label="Bugün sessize al"
          title="Bugün sessize al"
        >
          <X className="size-4" />
        </button>
      </header>
      {collapsed ? null : (
        <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto dark:divide-line-dark">
          {visible.map((r) => (
            <li key={`${r.id}:${r.kind}`} className="p-4" data-testid="appointment-reminder">
              <div className="flex items-start gap-3">
                <Avatar name={r.patient} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2">
                    <Link
                      href={`/appointments/${r.id}`}
                      className="truncate font-semibold hover:text-brand-700 dark:hover:text-brand-300"
                    >
                      {r.patient}
                    </Link>
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-slate-500">
                      <Clock3 className="size-3.5" aria-hidden="true" />
                      {r.localStart}–{r.localEnd}
                    </span>
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {[r.service, r.doctor, r.room].filter(Boolean).join(" · ")}
                  </p>
                  <p
                    className={cn(
                      "mt-1.5 text-xs font-medium",
                      r.kind === "overdue"
                        ? "text-amber-700 dark:text-amber-300"
                        : "text-brand-700 dark:text-brand-300",
                    )}
                  >
                    {KIND_TEXT[r.kind]}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-start justify-between gap-2">
                <QuickActionButtons
                  id={r.id}
                  actions={r.actions}
                  onDone={() => {
                    void load();
                    router.refresh();
                  }}
                />
                <Button variant="ghost" size="sm" onClick={() => snooze(r)}>
                  10 dk ertele
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
