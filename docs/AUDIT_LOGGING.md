# Audit Logging — Kliniva AI

## Tablo: `kliniva.audit_logs`

| Alan                       | Açıklama                                          |
| -------------------------- | ------------------------------------------------- |
| `id`                       | UUID                                              |
| `tenant_id`                | Kiracı (zorunlu; RLS)                             |
| `user_id`                  | İşlemi yapan kullanıcı (sistem işlemlerinde NULL) |
| `action`                   | Eylem kodu (aşağıda)                              |
| `entity_type`, `entity_id` | Etkilenen varlık (ör. `patient`, UUID)            |
| `branch_id`                | İlgili şube                                       |
| `source`                   | `USER` · `SYSTEM` · `AI_VOICE` · `API`            |
| `ip_hash`                  | IP'nin anahtarlı HMAC özeti (düz IP yok)          |
| `user_agent_summary`       | Kaba özet, ör. `Edge/Windows`                     |
| `metadata_safe`            | Yalnızca kısa kod / UUID / sayı / boolean         |
| `created_at`               | Zaman damgası                                     |

## Eylemler

| Eylem                                                                                         | Ne zaman                                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `LOGIN_SUCCESS` / `LOGIN_FAILED` (`reason`) / `LOGOUT`                                        | Kimlik doğrulama                                         |
| `MFA_ENROLLMENT_STARTED` / `MFA_ENABLED` / `MFA_FAILED`                                       | MFA                                                      |
| `SESSION_REVOKED_ALL`                                                                         | Diğer oturumları kapatma                                 |
| `PATIENT_CREATED` (`hasHealthNotes`)                                                          | Hasta oluşturma                                          |
| `PATIENT_VIEWED` / `PATIENT_HEALTH_VIEWED`                                                    | Hasta detayı (sağlık verisi dahil mi)                    |
| `PATIENT_UPDATED` (`fields`, `healthNotesChanged`, `nationalIdChanged`)                       | Güncelleme — yalnızca alan adları                        |
| `PATIENT_DUPLICATE_WARNING` (`matchCount`)                                                    | Olası mükerrer kayıt uyarısı                             |
| `PATIENT_DOCUMENT_CREATED` / `_PRESENTED` / `_SIGNED` / `_VIEWED` / `_DOWNLOADED` / `_VOIDED` | KVKK belgeleri                                           |
| `PATIENT_DOCUMENT_INTEGRITY_FAILED` (`part`)                                                  | PDF / snapshot / imza bütünlük ihlali (ayrı transaction) |
| `CONSENT_GRANTED` / `CONSENT_DENIED` / `CONSENT_REVOKED` (`consentKey`, `channel`)            | Açık rıza kararları — serbest metin gerekçe yazılmaz     |
| `DOCUMENT_TEMPLATE_VERSION_CREATED` / `DOCUMENT_TEMPLATE_PUBLISHED`                           | Şablon versiyonları                                      |
| `USER_CREATED` / `PERMISSION_CHANGED` (`roles`, `active`)                                     | Kullanıcı / yetki                                        |
| `BRANCH_CREATED` / `BRANCH_UPDATED` / `ROOM_CREATED`                                          | Organizasyon                                             |

## Kurallar

1. **Aynı transaction:** `writeAudit(scope, …)` işlemle aynı `tenantQuery` transaction'ında çalışır. İşlem başarılıysa
   audit kaydı vardır; geri alınırsa ikisi birden düşer.
2. **Yalnızca ekleme:** `audit_logs_guard` tetikleyicisi `UPDATE`'i her zaman, `DELETE`'i (yasal imha bağlamı
   dışında) engeller.
3. **Asla yazılmaz:** sağlık bilgisi, hasta notu, hasta adı/telefonu/e-postası, parola, token, `DATABASE_URL`,
   şifreleme anahtarı, imza/PDF içeriği.
4. **`sanitizeAuditMetadata`:** anahtar biçimi kontrol edilir; hassas görünen anahtarlarda yalnızca boolean bayrak
   kabul edilir; string değerler yalnızca `[A-Za-z0-9_.:,-]` (boşluk, `@`, Türkçe harf yok → isim/serbest metin
   geçemez) ve PII deseni içermiyorsa kabul edilir.
5. **AI eylemleri:** `actorOf(ctx, "AI_VOICE")` ile `source = AI_VOICE` yazılır; AI, çağıran kullanıcının bağlamıyla
   çalışır.

## Okuma

`audit.read` yetkisi (CLINIC_OWNER, CLINIC_ADMIN). Hasta dosyasındaki **Aktivite** sekmesi yalnızca eylem kodu, zaman ve işlemi yapan personelin adını gösterir.

## Uygulama log'ları (audit'ten ayrı)

`src/server/log/logger.ts` — JSON satırları, `sanitizeForLog` ile temizlenir: hassas anahtarlar `[REDACTED]`;
değerlerde bağlantı dizesi, e-posta, TCKN, telefon, JWT/Bearer, data URI, uzun base64 blob maskelenir.
