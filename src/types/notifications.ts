/** Bildirim merkezi — istemci ve sunucunun paylaştığı tipler (çalışma zamanı kodu yok). */
export type NotificationSeverityCode = "INFO" | "SUCCESS" | "WARNING" | "CRITICAL";
export type NotificationCategoryCode = "appointments" | "inventory" | "security";

export type NotificationView = {
  id: string;
  type: string;
  category: NotificationCategoryCode;
  severity: NotificationSeverityCode;
  title: string;
  body: string | null;
  status: "UNREAD" | "READ" | "ARCHIVED";
  createdAt: string;
  readAt: string | null;
  /** Kullanıcı varlığa HÂLÂ erişebiliyorsa bağlantı; yetki kaybedildiyse null. */
  href: string | null;
  /** Yetki kontrollü zenginleştirme (ör. "14:30 — Ayşe Yılmaz"). */
  context: string | null;
};

export type NotificationListResponse = {
  data: NotificationView[];
  total: number;
  unread: number;
  page: number;
  limit: number;
};
