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

| Eylem                                                                                                                                                                                                                   | Ne zaman                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `LOGIN_SUCCESS` / `LOGIN_FAILED` (`reason`) / `LOGOUT`                                                                                                                                                                  | Kimlik doğrulama                                                                                         |
| `MFA_ENROLLMENT_STARTED` / `MFA_ENABLED` / `MFA_FAILED`                                                                                                                                                                 | MFA                                                                                                      |
| `SESSION_REVOKED_ALL`                                                                                                                                                                                                   | Diğer oturumları kapatma                                                                                 |
| `PATIENT_CREATED` (`hasHealthNotes`)                                                                                                                                                                                    | Hasta oluşturma                                                                                          |
| `PATIENT_VIEWED` / `PATIENT_HEALTH_VIEWED`                                                                                                                                                                              | Hasta detayı (sağlık verisi dahil mi)                                                                    |
| `PATIENT_UPDATED` (`fields`, `healthNotesChanged`, `nationalIdChanged`)                                                                                                                                                 | Güncelleme — yalnızca alan adları                                                                        |
| `PATIENT_DUPLICATE_WARNING` (`matchCount`)                                                                                                                                                                              | Olası mükerrer kayıt uyarısı                                                                             |
| `PATIENT_DOCUMENT_CREATED` / `_PRESENTED` / `_SIGNED` / `_VIEWED` / `_DOWNLOADED` / `_VOIDED`                                                                                                                           | KVKK belgeleri                                                                                           |
| `PATIENT_DOCUMENT_INTEGRITY_FAILED` (`part`)                                                                                                                                                                            | PDF / snapshot / imza bütünlük ihlali (ayrı transaction)                                                 |
| `CONSENT_GRANTED` / `CONSENT_DENIED` / `CONSENT_REVOKED` (`consentKey`, `channel`)                                                                                                                                      | Açık rıza kararları — serbest metin gerekçe yazılmaz                                                     |
| `DOCUMENT_TEMPLATE_VERSION_CREATED` / `DOCUMENT_TEMPLATE_PUBLISHED`                                                                                                                                                     | Şablon versiyonları                                                                                      |
| `APPOINTMENT_CREATED` / `_VIEWED` / `_UPDATED` / `_RESCHEDULED` / `_CONFIRMED` / `_CHECKED_IN` / `_STARTED` / `_COMPLETED` / `_CANCELLED` / `_NO_SHOW` (`appointmentId`, `branchId`, `doctorId`, `serviceId`, `status`) | Randevu yaşam döngüsü — hasta adı / not / iptal gerekçesi yazılmaz                                       |
| `APPOINTMENT_CONFLICT` (`code`) / `DOCTOR_AVAILABILITY_VIEWED`                                                                                                                                                          | Çakışma reddi (ayrı transaction) / uygunluk sorgusu                                                      |
| `INVENTORY_ITEM_CREATED` / `_UPDATED` / `_DEACTIVATED`, `INVENTORY_CATEGORY_*`, `INVENTORY_LOCATION_*`                                                                                                                  | Stok kataloğu                                                                                            |
| `STOCK_INITIALIZED` / `STOCK_ADDED` / `STOCK_ADJUSTED` / `STOCK_TRANSFERRED` (`itemId`, `locationId`, `branchId`, `quantity`, `movementType`)                                                                           | Stok hareketleri                                                                                         |
| `PATIENT_MATERIAL_USAGE_CREATED` / `_FINALIZED` / `_VOIDED` (`patientUsageId`, `branchId`, `appointmentId`)                                                                                                             | Hasta kullanımı — not / VOID gerekçesi / hasta adı yazılmaz                                              |
| `LOW_STOCK_VIEWED`, `STOCK_BALANCE_MISMATCH`, `STOCK_BALANCE_RECONCILED`, `SERVICE_MATERIAL_TEMPLATE_UPDATED`                                                                                                           | Rapor / uzlaştırma / şablon                                                                              |
| `LOT_CREATED` / `LOT_STOCK_ADDED` / `LOT_TRANSFERRED` (`lotId`, `itemId`, `locationId`, `quantity`)                                                                                                                     | Lot girişi / transferi                                                                                   |
| `LOT_METADATA_CORRECTED` (`field`, `previous`, `next`)                                                                                                                                                                  | SKT düzeltmesi — gerekçe yazılmaz                                                                        |
| `LOT_RECALLED` (`lotId`, `affectedLots`)                                                                                                                                                                                | Geri çağırma — gerekçe şifreli tabloda, audit'e YAZILMAZ                                                 |
| `LOT_EXPIRY_VIEWED` (`kind`, `days`, `found`) / `EXPIRED_STOCK_WRITTEN_OFF` (`expired`, `recalled`, `quantity`) / `PHYSICAL_COUNT_RECORDED` (`expected`, `counted`, `adjusted`)                                         | SKT raporu / imha / sayım                                                                                |
| `PATIENT_LOT_USAGE_FINALIZED` (`patientUsageId`, `allocationCount`, `lots`)                                                                                                                                             | Lotlu hasta kullanımı — hasta kimliği bu kayıtta YOK                                                     |
| `LOT_PATIENT_TRACE_VIEWED` (`lotId`, `found`)                                                                                                                                                                           | Hasta izleme görüntülemesi — hasta kimlikleri YAZILMAZ                                                   |
| `NOTIFICATION_READ` / `NOTIFICATIONS_MARKED_READ` (`updated`)                                                                                                                                                           | Bildirim okundu — içerik yazılmaz                                                                        |
| `OUTBOX_FAILED` (`eventType`, `attempts`, `code`; yönetim `retryRequested`)                                                                                                                                             | Outbox olayı başarısız / yeniden kuyruğa — yük / mesaj yazılmaz                                          |
| `APPOINTMENT_APPROVED` / `APPOINTMENT_DECLINED`                                                                                                                                                                         | Doktor onayı                                                                                             |
| `LOW_STOCK_NOTIFICATION_CREATED` / `EXPIRY_NOTIFICATION_CREATED` / `LOT_RECALL_NOTIFICATION_CREATED` (`recipients`, `outboxEventId`)                                                                                    | Uyarı bildirimi oluşturuldu (olay başına bir kez; her bildirim için audit YOK — bildirim kaydı zaten iz) |
| `CLINICAL_SERVICE_CREATED` / `_UPDATED` / `DOCTOR_SERVICES_UPDATED`                                                                                                                                                     | Hizmet yönetimi                                                                                          |
| `USER_CREATED` / `PERMISSION_CHANGED` (`roles`, `active`)                                                                                                                                                               | Kullanıcı / yetki                                                                                        |
| `BRANCH_CREATED` / `BRANCH_UPDATED` / `ROOM_CREATED`                                                                                                                                                                    | Organizasyon                                                                                             |

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
5. **AI eylemleri (Sprint 7):** sesli asistan iş servislerini `ctx.channel = "AI_VOICE"` ile (yalnızca sunucu
   ayarlar) çağırır → `actorOf` audit / randevu geçmişi / randevu `source` alanına `AI_VOICE` yazar. AI, çağıran
   kullanıcının bağlamı, yetkisi ve RLS kapsamıyla çalışır. Ayrıca her yazma aracı `ai_action_logs` satırı üretir
   (REQUESTED → SUCCEEDED / FAILED / CANCELLED; onaylı mı; varlık kimliği); hasta adı, telefon, döküm, ses, iptal
   gerekçesi bu günlüğe YAZILMAZ. Ayrıntı: `docs/VOICE.md`.

## Okuma

`audit.read` yetkisi (CLINIC_OWNER, CLINIC_ADMIN). Hasta dosyasındaki **Aktivite** sekmesi yalnızca eylem kodu, zaman ve işlemi yapan personelin adını gösterir.

## Uygulama log'ları (audit'ten ayrı)

`src/server/log/logger.ts` — JSON satırları, `sanitizeForLog` ile temizlenir: hassas anahtarlar `[REDACTED]`;
değerlerde bağlantı dizesi, e-posta, TCKN, telefon, JWT/Bearer, data URI, uzun base64 blob maskelenir.
