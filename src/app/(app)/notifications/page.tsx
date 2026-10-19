import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { getNotificationPreferences, listNotifications } from "@/server/services/notifications";
import {
  archiveNotificationAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
  setNotificationPreferenceAction,
} from "@/app/actions/notifications";
import { InlineAction } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader } from "@/components/ui";
import { SeverityBadge } from "@/components/notification-ui";
import { formatDateTime } from "@/components/patient-ui";
import { LiveRefresh } from "@/components/notification-bell";

export const metadata: Metadata = { title: "Bildirimler" };

const FILTERS = [
  { key: "all", label: "Tümü" },
  { key: "unread", label: "Okunmamış" },
  { key: "appointments", label: "Randevular" },
  { key: "inventory", label: "Stok" },
  { key: "tasks", label: "Görevler" },
  { key: "security", label: "Güvenlik" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

/**
 * Bildirim merkezi — YALNIZCA oturumdaki kullanıcının bildirimleri. Varlık bağlantısı ("Görüntüle") yalnızca kullanıcı
 * varlığa hâlâ erişebiliyorsa gösterilir (servis yetki kontrollü çözer). Sayfalama 25 / en çok 100.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; page?: string }>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "notification.read_own")) return <Forbidden />;
  const sp = await searchParams;
  const filter: FilterKey = FILTERS.some((f) => f.key === sp.filter) ? (sp.filter as FilterKey) : "all";
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);
  const result = await listNotifications(ctx, { filter, page, limit: 25 });
  const pages = Math.max(Math.ceil(result.total / result.limit), 1);
  const prefs = hasPermission(ctx, "notification.preference.manage_own")
    ? await getNotificationPreferences(ctx)
    : [];
  const href = (f: FilterKey, p = 1) => `/notifications?filter=${f}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <section className="grid gap-6">
      <LiveRefresh />
      <PageHeader
        title="Bildirimler"
        description={`${result.unread} okunmamış bildirim`}
        actions={
          result.unread > 0 ? (
            <InlineAction
              action={markAllNotificationsReadAction}
              fields={{}}
              label="Tümünü okundu işaretle"
            />
          ) : null
        }
      />
      <nav aria-label="Bildirim filtreleri" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={href(f.key)}
            aria-current={filter === f.key ? "page" : undefined}
            className={filter === f.key ? "btn btn-sm" : "btn-ghost btn-sm"}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {result.items.length === 0 ? (
        <EmptyState title="Bildirim yok" />
      ) : (
        <ul className="grid gap-3" aria-label="Bildirim listesi">
          {result.items.map((n) => (
            <li
              key={n.id}
              className={`card flex flex-wrap items-start justify-between gap-3 ${n.status === "UNREAD" ? "border-brand-300 dark:border-brand-700" : ""}`}
              data-testid="notification-item"
              data-status={n.status}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={n.severity} />
                  <p className="font-semibold">{n.title}</p>
                  {n.status === "UNREAD" ? <span className="badge badge-brand">Yeni</span> : null}
                </div>
                {n.context ? <p className="mt-1 text-sm">{n.context}</p> : null}
                {n.body ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{n.body}</p> : null}
                <p className="mt-1 text-xs text-slate-500">
                  <time dateTime={n.createdAt}>{formatDateTime(new Date(n.createdAt))}</time>
                  {n.readAt ? " · okundu" : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {n.href ? (
                  <Link href={n.href} className="btn-ghost btn-sm">
                    Görüntüle
                  </Link>
                ) : null}
                {n.status === "UNREAD" ? (
                  <InlineAction action={markNotificationReadAction} fields={{ id: n.id }} label="Okundu" />
                ) : null}
                <InlineAction action={archiveNotificationAction} fields={{ id: n.id }} label="Arşivle" />
              </div>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 ? (
        <nav aria-label="Sayfalama" className="flex items-center justify-between text-sm">
          <span className="text-slate-500">
            Sayfa {result.page} / {pages} · {result.total} bildirim
          </span>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Link href={href(filter, result.page - 1)} className="btn-ghost btn-sm">
                ← Önceki
              </Link>
            ) : null}
            {result.page < pages ? (
              <Link href={href(filter, result.page + 1)} className="btn-ghost btn-sm">
                Sonraki →
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}

      {prefs.length ? (
        <details className="card">
          <summary className="cursor-pointer font-semibold">Bildirim tercihleri</summary>
          <p className="hint mt-2">
            Bu sürümde etkin kanal: uygulama içi. Güvenlik açısından kritik bildirimler kapatılamaz.
          </p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {prefs.map((p) => (
              <li key={p.type} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {p.label}
                  {p.mandatory ? <span className="badge badge-gray ml-2">Zorunlu</span> : null}
                </span>
                {p.mandatory ? (
                  <span className="text-xs text-slate-500">Açık</span>
                ) : (
                  <InlineAction
                    action={setNotificationPreferenceAction}
                    fields={{ type: p.type, inAppEnabled: p.inAppEnabled ? "false" : "true" }}
                    label={p.inAppEnabled ? "Kapat" : "Aç"}
                  />
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
