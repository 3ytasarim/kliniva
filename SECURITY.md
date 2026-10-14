# Güvenlik Politikası — Kliniva AI

Kliniva AI özel nitelikli kişisel veri (sağlık verisi) işler. Bu belge geliştirme ve işletim için bağlayıcı
güvenlik kurallarını özetler. Ayrıntılar: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Incident reporting (Güvenlik açığı / olay bildirimi)

- Açık veya şüpheli olay: **güvenlik sorumlusuna derhal** (kanal: proje yöneticisi, özel e-posta — herkese açık
  issue AÇMAYIN).
- Bildirimde: etkilenen bileşen, adımlar, zaman. **Hasta verisi, parola, token veya bağlantı dizesi eklemeyin.**
- Kişisel veri ihlali şüphesinde KVKK m.12/5 gereği Kurul'a **72 saat** içinde bildirim süreci başlatılır
  (veri sorumlusu: klinik; Kliniva veri işleyen sıfatıyla klinik ile koordineli çalışır).
- Olay sonrası: kök neden analizi, audit log incelemesi, etkilenen oturumların iptali, sır rotasyonu.

## Secret management (Sır yönetimi)

- Sırlar **yalnızca ortam değişkeni**: `DATABASE_URL`, `APP_ENCRYPTION_KEY`.
- Kaynak koda, README'ye, log'a, hata mesajına, test çıktısına, istemci paketine yazılmaz; Git'e girmez
  (`.env`, `.env.local`, `.env.production`, `*.env` → `.gitignore`).
- Otomatik kontroller: `.gitignore` testi, kaynak kodda bağlantı dizesi taraması (birim testi), build sonrası istemci
  paketi taraması (`npm run test:bundle`), `server-only` modül sınırı.
- `DATABASE_URL` eksikse uygulama `DATABASE_URL is required` hatası verir; değer asla mesaja konmaz.
- Üretimde sırlar barındırma platformunun şifreli ortam değişkenlerinde tutulur. Rotasyon: DB parolası Neon
  konsolundan, `APP_ENCRYPTION_KEY` versiyonlu rotasyonla (bkz. ARCHITECTURE → Anahtar rotasyonu).

## Access control (Erişim kontrolü)

- Tüm yetkilendirme **sunucuda**. Arayüzde öğe gizlemek güvenlik değildir.
- RBAC: rol → yetki (`patient.read`, `patient.health.read`, …). Her servis fonksiyonunun ilk satırı
  `requirePermission()`.
- Şube kapsamı: şubeye atanmış kullanıcı yalnızca o şubenin verisini görür.
- Yetki yükseltme koruması: kullanıcı yalnızca kendi yetkilerinin alt kümesini içeren rolleri atayabilir;
  `PLATFORM_SUPER_ADMIN` kiracı içinden atanamaz ve kiracı verisine erişim yetkisi yoktur.
- Erişilemeyen / başka kiracıya ait kayıt her zaman `404` döner (IDOR'da varlık sızdırılmaz).

## Password security (Parola güvenliği)

- Argon2id (m=19 MiB, t=2, p=1 — OWASP önerisi).
- Politika: 12–128 karakter, harf + rakam, yaygın parolalar yasak.
- Başarısız girişlerde genel hata; kullanıcı bulunmasa da aynı maliyette doğrulama (zamanlama sızıntısı yok).
- Hız sınırı: hesap başına 5 / 15 dk, IP başına 30 / 15 dk, MFA oturumu başına 5 / 15 dk (DB tabanlı).
- TOTP MFA (RFC 6238), sır AES-256-GCM ile şifreli, replay korumalı. MFA bypass/arka kapı yoktur.

## Tenant isolation (Kiracı izolasyonu)

Üç katman: (1) her kiracı tablosunda `tenant_id NOT NULL` + servis katmanında zorunlu `tenantWhere()`,
(2) bileşik yabancı anahtarlar `(tenant_id, x_id)`, (3) PostgreSQL **RLS (FORCE)** — kiracı bağlamı olmayan sorgu
hiçbir satır görmez. Ham DB istemcisi ESLint ile yasaklıdır; erişim yalnızca `tenantQuery(ctx, …)` üzerinden.
Bağlantı rolünün `BYPASSRLS`/süper kullanıcı olmadığı entegrasyon testiyle doğrulanır.

## Patient data handling (Hasta verisi)

- Sağlık verisi (`HEALTH_SPECIAL_CATEGORY`) uygulama düzeyinde AES-256-GCM ile şifreli; AAD ile satıra bağlı.
- Yalnızca `patient.health.read` yetkisiyle çözülür; listelerde hiç yer almaz; telefon listede maskelenir.
- Log, audit, analytics ve hata izleme sistemlerine **gönderilmez** (log temizleyici + audit metadata filtresi).
- İmza: yalnızca statik görüntü; biyometrik veri toplanmaz. İmza ve PDF'ler özel depoda şifreli, public URL yok.
- İmzalı belge değiştirilemez (DB tetikleyicisi); yeni metin = yeni versiyon.

## Backups (Yedekleme)

- Neon: otomatik nokta-zamanlı geri yükleme (PITR) — plan saklama süresi klinik sözleşmesine göre ayarlanır.
- Özel depo (imza/PDF): sürümlemeli, public erişimi kapalı bucket + çapraz bölge kopya (Sprint 1+ üretim adaptörü).
- Yedekler de şifrelidir; `APP_ENCRYPTION_KEY` yedeklerden **ayrı** saklanır (anahtar olmadan yedek okunamaz).
- Geri yükleme tatbikatı: çeyrek başına bir.

## Dependency updates (Bağımlılık güncellemeleri)

- `npm audit` her PR'da; kritik/yüksek bulgu birleştirmeyi engeller.
- Haftalık bağımlılık güncellemesi (Dependabot/Renovate), güvenlik yamaları 72 saat içinde.
- Kilit dosyası (`package-lock.json`) commit'lenir; yükleme betikleri npm `allow-scripts` ile denetlenir.

## Güvenlik başlıkları

Nonce'lu CSP (`strict-dynamic`, `frame-ancestors 'none'`, `object-src 'none'`), HSTS (üretim), `X-Frame-Options:
DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP. `X-Powered-By` kapalı.
