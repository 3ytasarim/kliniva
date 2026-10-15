import "server-only";
import { authenticate } from "@/server/auth/context";
import { requirePermission } from "@/server/auth/authz";
import { sessionTokenFromRequest } from "@/server/auth/guards";
import { requestMetaFrom } from "@/server/security/request-meta";
import { AppError } from "@/server/errors";
import { subscribe } from "@/server/notifications/bus";
import { getUnreadNotificationCount } from "@/server/services/notifications";

/**
 * SSE akışı — bildirim gerçek zamanlı sinyali.
 *
 * GÜVENLİK
 *  - Oturum zorunlu (çerez); ALICI = oturumdaki kullanıcı, KİRACI = oturumdaki kiracı. Sorgu parametreleri
 *    (ör. ?userId=, ?tenantId=) TAMAMEN yok sayılır → başka kullanıcının / kiracının akışına abone olunamaz.
 *  - Yük: yalnızca bildirim kimliği, tip, önem, zaman (içerik yok). İstemci listeyi yetkili uç noktadan yeniler.
 *  - Kalp atışında oturum YENİDEN doğrulanır: çıkış / oturum iptali / kullanıcı değişimi → akış kapanır.
 *  - En uzun ömür sınırlıdır (istemci EventSource otomatik yeniden bağlanır); kopmada abonelik temizlenir.
 */
const encoder = new TextEncoder();

export async function openNotificationStream(
  req: Request,
  opts: { heartbeatMs?: number; maxLifetimeMs?: number } = {},
): Promise<Response> {
  const token = sessionTokenFromRequest(req);
  const meta = requestMetaFrom(req.headers);
  const ctx = await authenticate(token, meta);
  if (!ctx) throw new AppError("UNAUTHENTICATED");
  requirePermission(ctx, "notification.read_own");
  const heartbeatMs = opts.heartbeatMs ?? Number(process.env.NOTIFICATION_SSE_HEARTBEAT_MS ?? 20_000);
  const maxLifetimeMs = opts.maxLifetimeMs ?? 15 * 60_000;
  const unread = await getUnreadNotificationCount(ctx);

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          close();
        }
      };
      const unsubscribe = subscribe(ctx.tenantId, ctx.userId, (s) => send("notification", s));
      let beating = false;
      const heartbeat = setInterval(async () => {
        if (beating || closed) return;
        beating = true;
        try {
          const again = await authenticate(token, meta);
          if (!again || again.userId !== ctx.userId || again.tenantId !== ctx.tenantId) {
            send("end", { reason: "SESSION_ENDED" });
            close();
            return;
          }
          send("heartbeat", { unread: await getUnreadNotificationCount(again) });
        } catch {
          close();
        } finally {
          beating = false;
        }
      }, heartbeatMs);
      const lifetime = setTimeout(() => {
        send("end", { reason: "RECONNECT" });
        close();
      }, maxLifetimeMs);
      function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();
        req.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // zaten kapalı
        }
      }
      cleanup = close;
      req.signal.addEventListener("abort", close);
      // EventSource yeniden bağlanma aralığı + ilk durum.
      controller.enqueue(encoder.encode(`retry: 5000\n\n`));
      send("ready", { unread });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
