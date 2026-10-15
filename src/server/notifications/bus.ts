import "server-only";

/**
 * Süreç içi bildirim yayını (SSE akışları için). Anahtar = kiracı + ALICI kullanıcı; abone yalnızca kendi
 * anahtarına bağlanabilir (anahtar SSE uç noktasında OTURUMDAN türetilir, istemci parametresinden değil).
 * Yayın yalnızca transaction COMMIT edildikten sonra yapılır (afterCommit). Yük: kimlik + tip + önem + zaman —
 * içerik yok; istemci listeyi yetkili uç noktadan yeniler.
 *
 * Sınır: tek süreç. Çok örnekli dağıtımda (yatay ölçek) diğer örneklerdeki abonelere bu yayın ulaşmaz; SSE akışı
 * ayrıca periyodik okunmamış sayısı kontrolüyle (kalp atışı) bunu telafi eder. İleride: Redis pub/sub veya doğrudan
 * (pooler olmayan) bağlantıda LISTEN/NOTIFY.
 */
export type NotificationSignal = {
  notificationId: string;
  type: string;
  severity: string;
  createdAt: string;
};

type Listener = (s: NotificationSignal) => void;

const g = globalThis as unknown as { __klinivaNotificationBus?: Map<string, Set<Listener>> };
const listeners: Map<string, Set<Listener>> = (g.__klinivaNotificationBus ??= new Map());

const keyOf = (tenantId: string, userId: string) => `${tenantId}:${userId}`;

export function subscribe(tenantId: string, userId: string, fn: Listener): () => void {
  const k = keyOf(tenantId, userId);
  let set = listeners.get(k);
  if (!set) {
    set = new Set();
    listeners.set(k, set);
  }
  set.add(fn);
  return () => {
    const s = listeners.get(k);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listeners.delete(k);
  };
}

export function publish(tenantId: string, userId: string, signal: NotificationSignal): void {
  const set = listeners.get(keyOf(tenantId, userId));
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(signal);
    } catch {
      // Abone hatası yayıncıyı etkilemez.
    }
  }
}

/** Test / izleme: etkin abone sayısı. */
export function subscriberCount(tenantId?: string, userId?: string): number {
  if (tenantId && userId) return listeners.get(keyOf(tenantId, userId))?.size ?? 0;
  let n = 0;
  for (const s of listeners.values()) n += s.size;
  return n;
}
