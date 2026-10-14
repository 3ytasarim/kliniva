# Veri Sınıflandırması — Kliniva AI

## Seviyeler

| Seviye                    | Tanım                                 | Örnek                                                                  | Depolama                         | Log / Audit / Analytics / Hata izleme |
| ------------------------- | ------------------------------------- | ---------------------------------------------------------------------- | -------------------------------- | ------------------------------------- |
| `PUBLIC`                  | Herkese açık olabilir                 | Ürün adı, genel yardım metni                                           | Serbest                          | Serbest                               |
| `INTERNAL`                | Kurum içi, kişisel değil              | Şube adı, oda adı, rol/yetki anahtarları, audit eylem kodları          | DB                               | Serbest (kimlik olarak)               |
| `PERSONAL`                | Kişiyi tanımlar                       | Hasta/personel adı, telefon, e-posta, doğum tarihi                     | DB (erişim yetkiye bağlı)        | **Yazılmaz** — yalnızca UUID          |
| `SENSITIVE_PERSONAL`      | Ele geçirilirse ciddi zarar           | Parola özeti, oturum token özeti, MFA sırrı, imza görüntüsü, IP adresi | Şifreli/özetli                   | **Asla**                              |
| `HEALTH_SPECIAL_CATEGORY` | KVKK m.6 özel nitelikli sağlık verisi | Tıbbi notlar, tanı, tedavi, imzalı onam/rıza belgeleri ve seçimleri    | AES-256-GCM şifreli + ayrı yetki | **Asla**                              |

## Kurallar — HEALTH_SPECIAL_CATEGORY

Bu veriler:

- **istemci log'larında bulunamaz** (tarayıcıda `console.*` ile yazdırılmaz),
- **uygulama log'larında düz metin bulunamaz** (`sanitizeForLog` anahtar + değer temizliği),
- **analytics'e gönderilemez** (analitik olayları yalnızca olay adı ve sayısal/boolean özellik taşır),
- **hata izleme sistemlerine payload olarak gönderilemez** (istek gövdesi/yanıtı eklenmez; hata mesajı temizlenir),
- yalnızca `patient.health.read` yetkisiyle çözülür ve her erişim `PATIENT_HEALTH_VIEWED` olarak audit'lenir,
- listelerde gösterilmez; yalnızca kayıt detayında, yetkiliye.

## Tablo / alan eşlemesi

| Tablo.alan                                                    | Sınıf                           | Koruma                                                     |
| ------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| `tenants.*`                                                   | INTERNAL                        | —                                                          |
| `branches.*`, `rooms.*`                                       | INTERNAL                        | RLS                                                        |
| `users.first_name/last_name/email/phone`                      | PERSONAL                        | RLS, `user.read`                                           |
| `users.password_hash`                                         | SENSITIVE_PERSONAL              | Argon2id                                                   |
| `users.two_factor_secret_encrypted`                           | SENSITIVE_PERSONAL              | AES-256-GCM                                                |
| `sessions.token_hash`                                         | SENSITIVE_PERSONAL              | SHA-256 (ham token saklanmaz)                              |
| `sessions.ip_hash`, `audit_logs.ip_hash`                      | SENSITIVE_PERSONAL (türetilmiş) | HMAC (IP düz metin yok)                                    |
| `patients.first_name/last_name/phone/email/birth_date/gender` | PERSONAL                        | RLS, `patient.read`, şube kapsamı, listede maskeli telefon |
| `patients.notes_encrypted`                                    | HEALTH_SPECIAL_CATEGORY         | AES-256-GCM, AAD, `patient.health.*`                       |
| `patient_documents.*`, `consent_choices.*`                    | HEALTH_SPECIAL_CATEGORY         | RLS, `document.*`, değiştirilemez                          |
| İmza PNG / imzalı PDF (özel depo)                             | HEALTH_SPECIAL_CATEGORY         | Şifreli depo, public URL yok                               |
| `audit_logs.metadata_safe`                                    | INTERNAL                        | Yalnızca kod/UUID/bayrak (`sanitizeAuditMetadata`)         |
| `rate_limits.key`                                             | INTERNAL (türetilmiş)           | HMAC                                                       |

## Gelecekteki alanlar

TC kimlik numarası eklenirse: `SENSITIVE_PERSONAL`, şifreli + aranabilir HMAC sütunu; log temizleyici 11 haneli
TCKN desenini zaten maskeler.
