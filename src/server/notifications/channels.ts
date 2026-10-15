import "server-only";
import { notifications } from "@/server/db/schema";
import { afterCommit, type TenantScope } from "@/server/tenant/tenant-query";
import { publish } from "@/server/notifications/bus";
import type { NotificationSeverity, NotificationType } from "@/server/notifications/catalog";

/**
 * Bildirim kanalları. Bu sürümde YALNIZCA uygulama içi kanal etkindir. E-posta / push / SMS / WhatsApp yalnızca
 * arayüz olarak tanımlıdır — ağ entegrasyonu YOK. Gelecek kanallar outbox işlemcisi tarafından AYNI tekilleştirme
 * anahtarıyla çağrılacak; ağ çağrıları DB transaction'ı dışında yapılmalı (uzun kilit tutulmaz).
 */
export type NotificationMessage = {
  recipientUserId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  bodySafe: string | null;
  entityType: string | null;
  entityId: string | null;
  branchId: string | null;
  deduplicationKey: string;
  metadataSafe?: Record<string, string | number | boolean | null>;
};

export type ChannelResult = { delivered: boolean; duplicate: boolean; notificationId?: string };

export interface NotificationChannel {
  readonly name: "IN_APP" | "EMAIL" | "PUSH" | "SMS" | "WHATSAPP";
  send(scope: TenantScope, message: NotificationMessage): Promise<ChannelResult>;
}

/**
 * Uygulama içi bildirim: tekilleştirme anahtarı (kiracı + anahtar benzersiz) ile idempotent ekleme — outbox tekrar
 * işlense de aynı mantıksal bildirim İKİ KEZ oluşmaz. Yayın yalnızca commit sonrası.
 */
export class InAppNotificationChannel implements NotificationChannel {
  readonly name = "IN_APP" as const;

  async send(scope: TenantScope, m: NotificationMessage): Promise<ChannelResult> {
    const [row] = await scope.tx
      .insert(notifications)
      .values({
        tenantId: scope.tenantId,
        recipientUserId: m.recipientUserId,
        branchId: m.branchId,
        type: m.type,
        severity: m.severity,
        title: m.title,
        bodySafe: m.bodySafe,
        entityType: m.entityType,
        entityId: m.entityId,
        deduplicationKey: m.deduplicationKey,
        metadataSafe: m.metadataSafe ?? null,
      })
      .onConflictDoNothing({ target: [notifications.tenantId, notifications.deduplicationKey] })
      .returning({ id: notifications.id, createdAt: notifications.createdAt });
    if (!row) return { delivered: false, duplicate: true };
    const tenantId = scope.tenantId;
    afterCommit(scope, () =>
      publish(tenantId, m.recipientUserId, {
        notificationId: row.id,
        type: m.type,
        severity: m.severity,
        createdAt: row.createdAt.toISOString(),
      }),
    );
    return { delivered: true, duplicate: false, notificationId: row.id };
  }
}

/** Gelecek kanal saplaması: çağrılırsa açıkça başarısız olur (sessizce "gönderildi" demez). */
class NotImplementedChannel implements NotificationChannel {
  constructor(readonly name: "EMAIL" | "PUSH" | "SMS" | "WHATSAPP") {}
  async send(): Promise<ChannelResult> {
    throw new Error(`CHANNEL_${this.name}_NOT_ENABLED`);
  }
}

export const EmailNotificationChannel = () => new NotImplementedChannel("EMAIL");
export const PushNotificationChannel = () => new NotImplementedChannel("PUSH");
export const SmsNotificationChannel = () => new NotImplementedChannel("SMS");
export const WhatsAppNotificationChannel = () => new NotImplementedChannel("WHATSAPP");
