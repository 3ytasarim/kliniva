import type { NotificationSeverityCode } from "@/types/notifications";

/** Bildirim ekranlarında ortak etiketler (sunucu ve istemci bileşeni olarak kullanılabilir). */
export const SEVERITY_DOT: Record<NotificationSeverityCode, string> = {
  INFO: "bg-sky-500",
  SUCCESS: "bg-emerald-500",
  WARNING: "bg-amber-500",
  CRITICAL: "bg-red-600",
};

export const SEVERITY_BADGE: Record<NotificationSeverityCode, [string, string]> = {
  INFO: ["badge-sky", "Bilgi"],
  SUCCESS: ["badge-green", "Başarılı"],
  WARNING: ["badge-amber", "Uyarı"],
  CRITICAL: ["badge-red", "Kritik"],
};

export function SeverityBadge({ severity }: { severity: NotificationSeverityCode }) {
  const [cls, label] = SEVERITY_BADGE[severity];
  return <span className={`badge ${cls}`}>{label}</span>;
}

/** "az önce", "5 dk önce", "3 sa önce", "2 gün önce" — yerel saat bilgisi gerektirmez. */
export function timeAgo(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "az önce";
  if (min < 60) return `${min} dk önce`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} sa önce`;
  return `${Math.floor(h / 24)} gün önce`;
}
