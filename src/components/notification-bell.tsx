"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationListResponse, NotificationView } from "@/types/notifications";
import { SEVERITY_DOT, timeAgo } from "@/components/notification-ui";

/**
 * Üst bilgi bildirim zili — okunmamış rozeti + son bildirimler. Gerçek zamanlı: SSE akışı (alıcı OTURUMDAN; istemci
 * kullanıcı kimliği göndermez). Sinyal yalnızca kimlik / tip taşır → liste yetkili uç noktadan yenilenir.
 * Diğer ekranlar (ör. Bugünkü operasyon) "kliniva:notification" pencere olayını dinleyerek yenilenebilir.
 */
export const NOTIFICATION_EVENT = "kliniva:notification";

export function NotificationBell() {
  const [items, setItems] = useState<NotificationView[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch("/api/v1/notifications?limit=8", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as NotificationListResponse;
      if (mine !== seq.current) return; // daha yeni bir istek var
      setItems(body.data);
      setUnread(body.unread);
    } catch {
      // ağ hatası: bir sonraki sinyalde / kalp atışında yeniden denenir
    }
  }, []);

  useEffect(() => {
    // İlk yükleme effect gövdesinden ayrı (eşzamanlı setState yok); SSE "ready" de yeniler.
    const first = setTimeout(() => void refresh(), 0);
    const es = new EventSource("/api/v1/notifications/stream");
    es.addEventListener("open", () => setLive(true));
    es.addEventListener("error", () => setLive(false));
    es.addEventListener("notification", () => {
      void refresh();
      window.dispatchEvent(new CustomEvent(NOTIFICATION_EVENT));
    });
    es.addEventListener("heartbeat", (e) => {
      try {
        const n = (JSON.parse((e as MessageEvent).data) as { unread?: number }).unread;
        if (typeof n === "number") setUnread((cur) => (cur === n ? cur : (void refresh(), n)));
      } catch {
        // yok say
      }
    });
    es.addEventListener("end", () => es.close());
    return () => {
      clearTimeout(first);
      es.close();
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const post = async (url: string) => {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await refresh();
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread ? `Bildirimler (${unread} okunmamış)` : "Bildirimler"}
        data-live={live ? "on" : "off"}
        className="relative grid size-11 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:shadow-focus aria-expanded:bg-slate-100 aria-expanded:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-slate-100 dark:aria-expanded:bg-white/5"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-[22px]">
          <path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z" />
        </svg>
        {unread > 0 ? (
          <span
            data-testid="notification-badge"
            className="absolute right-1.5 top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-red-600 px-1 text-[10px] font-semibold tabular-nums text-white ring-2 ring-white dark:ring-canvas-dark"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Son bildirimler"
          className="animate-enter absolute right-0 top-full z-50 mt-2 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-white shadow-raised dark:border-line-dark dark:bg-raised-dark"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3 dark:border-line-dark">
            <p className="text-sm font-semibold">Bildirimler</p>
            {unread > 0 ? (
              <button
                type="button"
                className="rounded text-xs font-medium text-brand-700 hover:underline focus-visible:outline-none focus-visible:shadow-focus dark:text-brand-300"
                onClick={() => void post("/api/v1/notifications/read-all")}
              >
                Tümünü okundu işaretle
              </button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-500">Bildirim yok.</p>
          ) : (
            <ul className="max-h-[26rem] divide-y divide-slate-100 overflow-y-auto dark:divide-line-dark">
              {items.map((n) => (
                <li
                  key={n.id}
                  className={`px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.02] ${n.status === "UNREAD" ? "bg-brand-50/50 dark:bg-brand-500/5" : ""}`}
                >
                  <div className="flex items-start gap-2">
                    <span
                      aria-hidden="true"
                      className={`mt-1.5 size-2 shrink-0 rounded-full ${SEVERITY_DOT[n.severity]}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{n.title}</p>
                      {n.context ? <p className="text-sm">{n.context}</p> : null}
                      {n.body ? <p className="text-xs text-slate-600 dark:text-slate-400">{n.body}</p> : null}
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                        <time dateTime={n.createdAt} className="text-slate-500">
                          {timeAgo(n.createdAt)}
                        </time>
                        {n.href ? (
                          <Link
                            href={n.href}
                            className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                            onClick={() => setOpen(false)}
                          >
                            Görüntüle
                          </Link>
                        ) : null}
                        {n.status === "UNREAD" ? (
                          <button
                            type="button"
                            className="font-medium text-slate-600 hover:underline dark:text-slate-300"
                            onClick={() => void post(`/api/v1/notifications/${n.id}/read`)}
                          >
                            Okundu
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line bg-slate-50/60 px-4 py-2.5 text-center dark:border-line-dark dark:bg-white/[0.02]">
            <Link
              href="/notifications"
              className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
              onClick={() => setOpen(false)}
            >
              Tümünü gör
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Bildirim (SSE) sinyali geldiğinde ve periyodik olarak sunucu bileşenini yeniler (ör. Bugünkü operasyon). */
export function LiveRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 300);
    };
    window.addEventListener(NOTIFICATION_EVENT, go);
    const iv = setInterval(go, intervalMs);
    return () => {
      window.removeEventListener(NOTIFICATION_EVENT, go);
      clearInterval(iv);
      clearTimeout(timer);
    };
  }, [intervalMs, router]);
  return null;
}
