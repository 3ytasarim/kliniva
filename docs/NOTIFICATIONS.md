# Bildirim Merkezi, Transactional Outbox ve Gerçek Zamanlı Operasyon — Kliniva AI (Sprint 6)

## Bileşenler

| Bileşen           | Dosya                                                                 | Görev                                                                                                              |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Katalog           | `src/server/notifications/catalog.ts`                                 | Tipler, kategori, önem, zorunlu (kapatılamaz) tipler, PII'siz metin yardımcıları                                   |
| Outbox            | `src/server/notifications/outbox.ts`                                  | `enqueueOutbox` (iş transaction'ı içinde), `processOutboxBatch`, yeniden deneme, başarısız olay yönetimi           |
| Alıcılar          | `src/server/notifications/recipients.ts`                              | `resolveNotificationRecipients` — olay bazlı, şube kapsamlı, tercihlere uyan                                       |
| Kanallar          | `src/server/notifications/channels.ts`                                | `NotificationChannel` arayüzü; etkin: `InAppNotificationChannel`; e-posta / push / SMS / WhatsApp yalnızca saplama |
| Yayın             | `src/server/notifications/bus.ts`                                     | Süreç içi kiracı + alıcı anahtarlı yayın (commit sonrası)                                                          |
| SSE               | `src/server/notifications/sse.ts`, `GET /api/v1/notifications/stream` | Gerçek zamanlı sinyal                                                                                              |
| SKT taraması      | `src/server/notifications/expiry-scan.ts`                             | `scanExpiryNotifications`                                                                                          |
| İşçi              | `src/server/notifications/worker.ts` (instrumentation)                | Outbox poller (5 sn) + SKT taraması (60 dk)                                                                        |
| Kullanıcı servisi | `src/server/services/notifications.ts`                                | Liste, okunmamış sayısı, okundu / tümü / arşiv, tercihler, yetki kontrollü bağlantı çözümü                         |
| Stok eşikleri     | `src/server/services/stock-alerts.ts`                                 | Kullanılabilir stokta eşik GEÇİŞİ tespiti                                                                          |

## Veri modeli

- `notifications` — kiracı + ALICI kapsamlı. Başlık / gövde PII içermez; varlık referansı (`entity_type`, `entity_id`).
  `deduplication_key` kiracı içinde benzersiz. Durum: `UNREAD → READ → ARCHIVED` (veya `UNREAD → ARCHIVED`); içerik
  değişmez (tetikleyici), uygulama rolü yalnızca `status / read_at / archived_at` sütunlarını güncelleyebilir; silme yok.
- `notification_preferences` — kullanıcı × tip; bu sürümde etkin kanal `in_app_enabled`; diğer kanal bayrakları gelecek
  için. `LOT_RECALLED`, `DOCUMENT_INTEGRITY_FAILED`, `SYSTEM_SECURITY_ALERT` kapatılamaz.
- `outbox_events` — `event_type`, `aggregate_type / aggregate_id`, `payload_safe` (yalnızca kimlik / kısa kod / zaman),
  `status (PENDING / PROCESSING / PROCESSED / FAILED)`, `attempt_count`, `available_at`, `processed_at`,
  `last_error_code` (yalnızca `^[A-Z0-9_]+$` kod — mesaj / yığın izi / sır yazılmaz), `deduplication_key` (üretim
  tekilleştirmesi). Yük / tip / toplam değişmez (tetikleyici); silme yok (saklama ileride bakım işi).
- Üç tabloda RLS ENABLE + FORCE (`tenant_isolation`). Alıcı kapsamı servis katmanındadır (her sorgu
  `recipient_user_id = oturum kullanıcısı`); başka kullanıcının bildirim kimliği → `NOT_FOUND`.

## Transactional outbox

1. İş servisi olayı **aynı transaction'da** yazar (`enqueueOutbox(scope, …)`): randevu + geçmiş + outbox; stok hareketi
   - outbox. İş geri alınırsa olay da yoktur; iş başarılıysa olay kaybolmaz.
2. Commit sonrası (`afterCommit`) süreç içi işlemci dürtülür (gerçek zamanlılık); periyodik poller kaçırılanları ve
   ileri tarihli yeniden denemeleri işler.
3. `processOutboxBatch({ batchSize })`: kiracı keşfi `kliniva.outbox_ready_tenants()` (SECURITY DEFINER, YALNIZCA kiracı
   kimlikleri) → her kiracı kendi RLS bağlamında `SELECT … FOR UPDATE SKIP LOCKED LIMIT n`. Aynı olay aynı anda iki
   işçide işlenemez; işçi çökerse kilit düşer, olay `PENDING` kalır. Her olay ayrı SAVEPOINT'te.
4. Garanti: **en az bir kez** (exactly-once iddiası yok). Bildirim ekleme `ON CONFLICT (tenant_id, deduplication_key)
DO NOTHING` → tekrar işleme yinelenen bildirim üretmez.
5. Yeniden deneme: hata → `attempt_count + 1`, `available_at` = şimdi + 1 / 5 / 15 / 60 dk; 5. denemede `FAILED` +
   `OUTBOX_FAILED` audit. İş transaction'ı geri alınmaz.
6. `/settings/system-events` (sahip / yönetici, kiracı geneli): tip, toplam, deneme, durum, zaman, hata kodu — ham yük
   gösterilmez; "Yeniden dene" olayı `PENDING`e alır (idempotent).

### Tekilleştirme anahtarları

| Olay                                                                          | Anahtar                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Randevu oluşturuldu / iptal / onaylandı / onay gerekli / doktor onayı / reddi | `appointment-<tür>:<randevu>:<alıcı>`                                          |
| Hasta giriş yaptı                                                             | `patient-checkin:<randevu>:<alıcı>`                                            |
| Taşıma                                                                        | `appointment-rescheduled:<outbox olayı>:<alıcı>` (her taşıma ayrı)             |
| Düşük / tükenen stok                                                          | `low-stock:<ürün>:<lokasyon>:<eşik döngüsü = outbox olayı>:<alıcı>`            |
| SKT yaklaşıyor / geçti                                                        | outbox: `lot-expiring                                                          | lot-expired:<lot>:<SKT>`; bildirim: `…:<alıcı>` |
| Geri çağırma                                                                  | outbox: `lot-recalled:<ürün>:<lot no>`; bildirim: `lot-recalled:<lot>:<alıcı>` |
| Belge bütünlüğü                                                               | `doc-integrity:<belge>:<parça>:<alıcı>`                                        |

## Alıcılar

| Bildirim                                                            | Alıcı                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| Yeni / taşınan / onaylanan randevu, hasta giriş yaptı, onay gerekli | randevunun doktoru                                              |
| İptal                                                               | doktor + randevuyu oluşturan                                    |
| Doktor onayladı / reddetti                                          | randevuyu oluşturan                                             |
| Düşük / tükenen stok, SKT yaklaşıyor / geçti                        | stok sorumlusu (şubeyi kapsayan) + yönetici + sahip             |
| Lot geri çağrıldı                                                   | sahip + yönetici + etkilenen şubeleri kapsayan stok sorumluları |
| Belge bütünlüğü / güvenlik                                          | sahip + yönetici                                                |

İşlemi yapan kullanıcı randevu bildirimlerinde hariç tutulur; pasif kullanıcı bildirim almaz.

## Gizlilik

Bildirim içeriği yalnızca saat, hizmet adı, ürün / lot / lokasyon adı içerir; hasta adı, telefon, TC kimlik, not,
belge içeriği, imza, geri çağırma / iptal gerekçesi YAZILMAZ (son savunma: `assertSafeText` uzun sayı / e-posta
desenlerini reddeder). UI'da "14:30 — Ayşe Yılmaz" bağlamı ve "Görüntüle" bağlantısı **yetki kontrollü** servisle
çözülür; kullanıcı varlığa erişimi kaybettiyse bağlantı / bağlam gösterilmez.

## Gerçek zamanlı (SSE)

`GET /api/v1/notifications/stream` — oturum zorunlu; **alıcı ve kiracı oturumdan** türetilir, sorgu parametreleri
(`?userId=`, `?tenantId=`) tamamen yok sayılır. Olaylar: `ready {unread}`, `notification {notificationId, type,
severity, createdAt}` (içerik yok), `heartbeat {unread}` (20 sn; her kalp atışında oturum yeniden doğrulanır — çıkış /
iptal → `end` + kapanış), `end`. En uzun ömür 15 dk (istemci yeniden bağlanır). Kopmada abonelik temizlenir.

Sınır: yayın süreç içidir. Çok örnekli dağıtımda diğer örneğin abonesi anlık sinyali almaz; kalp atışındaki okunmamış
sayısı bunu telafi eder (≤ 20 sn). İleride: Redis pub/sub veya doğrudan bağlantıda LISTEN/NOTIFY.

## Bugünkü operasyon (`/operations/today`)

Randevu durum makinesi kaynak gerçektir (ikinci durum sistemi yok). Gruplar: Beklenen (onay bekleyen / planlandı /
onaylandı), Geldi, İşlemde, Tamamlandı, Gelmedi. Eylemler mevcut izinlerle: resepsiyon giriş / gelmedi / iptal,
doktor başlat / tamamla. Ekran bildirim sinyalinde ve 20 sn'de bir yenilenir.

## Doktor randevu onayı

`clinic_profiles.appointment_approval_mode`: `AUTO_ACCEPT` (varsayılan — doğrudan `BOOKED`) / `DOCTOR_APPROVAL`
(yeni randevu `PENDING_APPROVAL`; doktorun kendi oluşturduğu randevu hariç). `PENDING_APPROVAL` slotu tutar (doktor /
oda / hasta exclusion constraint aktif listesinde). Doktor YALNIZCA kendi randevusunu onaylar (`→ BOOKED`) / reddeder
(`→ CANCELLED`, slot hemen müsait); başka doktorun randevusu `NOT_FOUND`, resepsiyon `FORBIDDEN`. Geçmiş olayları
`APPROVED` / `DECLINED`. `approval_expires_at` otomatik zaman aşımı için temel (bu sürümde iş yok).

## Stok / SKT uyarıları

- Eşik GEÇİŞİ (stok kilidi altında, kullanılabilir stok): önce > min ve sonra ≤ min → `LOW_STOCK`; önce > 0 ve sonra
  = 0 → `OUT_OF_STOCK` (ikisi birden olursa yalnızca bu). Zaten düşükken (4 → 3) yeni olay yok; yükselip (3 → 10) tekrar
  inerse (10 → 5) yeni olay. Kontrol edilen hareketler: düzeltme, transfer (kaynak), hasta kullanımı, imha, sayım, geri
  çağırma.
- `scanExpiryNotifications()`: şube saat dilimi + klinik `expiryWarningDays`; miktarı > 0 ve geri çağrılmamış lotlar;
  pencereye ilk giriş `LOT_EXPIRING_SOON`, ilk geçiş `LOT_EXPIRED` (tarama SKT sonrası ilk kez görürse doğrudan bu).
  Tekrar tarama yeni olay üretmez.
- Geri çağırma: `LOT_RECALLED` (gerekçe yazılmaz). Geri çağırma yetkisi Sprint 5 kuralıyla: yalnızca kiracı geneli sahip
  / yönetici.

## İzinler

| İzin                                                          | Kimde                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `notification.read_own`, `notification.preference.manage_own` | tüm kiracı rolleri                                                                              |
| `notification.admin.read_failed_events`                       | sahip, yönetici (+ kiracı geneli kapsam)                                                        |
| `appointment.approve_own`, `appointment.decline_own`          | doktor (+ sahip / yönetici: yalnızca kendi doktor kaydı varsa anlamlı — başkası adına onay YOK) |

## Gelecek kanallar

`EmailNotificationChannel`, `PushNotificationChannel`, `SmsNotificationChannel`, `WhatsAppNotificationChannel` arayüzü
uygular ama çağrılırsa `CHANNEL_<X>_NOT_ENABLED` ile başarısız olur (sessizce "gönderildi" demez). Ağ çağrıları DB
transaction'ı dışında yapılacak şekilde iki aşamalı işleme (`PROCESSING` durumu) ile eklenecek.
