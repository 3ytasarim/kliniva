# Veritabanı — Kliniva AI

## Kritik kural

- **Mevcut** Neon PostgreSQL kullanılır. Uygulama, betikler ve testler **yeni veritabanı / Neon projesi / SQLite /
  yerel yedek veritabanı oluşturmaz**; başka bir veritabanı servisi kullanılmaz.
- İki ayrı bağlantı (değerler asla mesaja, log'a, README'ye, test çıktısına, istemci paketine yazılmaz):

  | Değişken                 | Kim kullanır                                                       | Host            | Rol                         |
  | ------------------------ | ------------------------------------------------------------------ | --------------- | --------------------------- |
  | `DATABASE_URL`           | Uygulama runtime'ı + entegrasyon testlerinin test edilen sorguları | Neon **pooled** | `kliniva_app` (en az yetki) |
  | `MIGRATION_DATABASE_URL` | migrate, seed, rol kurulumu, inspect, test kurulum/temizlik        | Neon **direct** | şema sahibi                 |

  Eksikse yalnızca değişken adıyla hata verilir (`DATABASE_URL is required` / `MIGRATION_DATABASE_URL is required`).

- Migration'lar aynı mevcut veritabanında, ayrı **`kliniva`** Postgres şemasında çalışır (veritabanındaki diğer
  şemalara dokunulmaz).

## Migration aracı: drizzle-kit

| Komut                 | DB'ye bağlanır mı? | Ne yapar                                                                             |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `npm run db:generate` | Hayır              | Şema farkından `drizzle/NNNN_*.sql` üretir                                           |
| `npm run db:migrate`  | Evet               | Ön kontrol → bekleyen dosyalar tek transaction → son kontrol                         |
| `npm run db:inspect`  | Evet (salt okunur) | Rol öznitelikleri, kliniva durumu, RLS/FORCE, kliniva_app yetkileri, şema parmak izi |
| `npm run db:app-role` | Evet               | kliniva_app LOGIN + SCRAM parola; DATABASE_URL yoksa pooled olarak ekler             |

- **Shadow database yoktur** (drizzle-kit shadow DB kavramı kullanmaz).
- `drizzle-kit push` **kullanılmaz** (gözden geçirilmemiş şema değişikliği).
- `drizzle.config.ts` → `schemaFilter: ["kliniva"]`, migration tablosu `kliniva.__drizzle_migrations`.
- Neon **pooler** host'u çok ifadeli sorgularda sorun çıkarabildiği için migration'ları **doğrudan (pooler olmayan)
  host** ile çalıştırın; tüm ifadeler `--> statement-breakpoint` ile ayrılmıştır.

## Migration listesi

| Dosya                                    | İçerik                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000_init.sql`                          | `kliniva` şeması, 6 enum, 15 tablo, bileşik FK'ler, benzersiz kısıtlar, indeksler                                                                                                                                                                                                                                                             |
| `0002_app_role.sql`                      | `kliniva_app` (NOLOGIN, tehlikeli öznitelik yok) + tablo bazlı yetki matrisi; PLATFORM_SUPER_ADMIN atama yasağı tetikleyicisi                                                                                                                                                                                                                 |
| `0003_scheduling.sql`                    | Sprint 1: 8 yeni tablo, branches/rooms genişletme, rooms.type → enum (veri eşlemeli dönüşüm), kiracı güvenli bileşik FK'ler                                                                                                                                                                                                                   |
| `0004_scheduling_security.sql`           | btree_gist (kliniva şemasında), 5 exclusion constraint (çakışma motoru), 8 tabloda RLS ENABLE+FORCE, kliniva_app yetkileri                                                                                                                                                                                                                    |
| `0005_patient_crm.sql`                   | Sprint 2: `patient_branches`, `consent_revocations`, hasta iletişim/normalize alanları, şifreli TC kimlik, belge snapshot + VOID alanları, `signer_type`, `GENERATED → DRAFT` (RENAME VALUE, veri korunur), hasta no öneki                                                                                                                    |
| `0006_patient_crm_security.sql`          | Belge durum makinesi tetikleyicisi (yeniden yazıldı), rıza geri çekme tetikleyicisi, 2 tabloda RLS ENABLE+FORCE, yetkiler, `patient_branches` ve normalize telefon/e-posta geri doldurma                                                                                                                                                      |
| `0007_appointments.sql`                  | Sprint 3: `clinical_services`, `doctor_services`, `appointments`, `appointment_events`, 3 enum, randevu yapılandırması (`clinic_profiles`), indeksler                                                                                                                                                                                         |
| `0008_appointments_security.sql`         | Doktor / oda / hasta `tstzrange` exclusion constraint'ları, durum makinesi tetikleyicisi, geçmiş append-only, 4 tabloda RLS ENABLE+FORCE, yetkiler                                                                                                                                                                                            |
| `0009_inventory.sql`                     | Sprint 4: 9 stok tablosu, 4 enum, bileşik kiracı FK'ları (randevu ↔ hasta ↔ şube dahil), indeksler, `allow_negative_stock` (= false)                                                                                                                                                                                                          |
| `0010_inventory_security.sql`            | Defter → bakiye tetikleyicisi (SECURITY DEFINER, yetersiz stok reddi), defter append-only, kullanım durum makinesi, kalem koruması, `recompute_stock_balance`, 9 tabloda RLS ENABLE+FORCE, yetkiler                                                                                                                                           |
| `0011_inventory_lots.sql`                | Sprint 5: `stock_lots` üretim seviyesi (lot no zorunlu, teslim, tedarikçi ref., aktif, geri çağırma, `updated_at`), kimlik benzersizliği, `patient_material_usage_allocations`, `expiry_warning_days`, SKT ⇒ lot CHECK; eski `lot_id` sütunları kaldırıldı (önce veri yoksa — korumalı)                                                       |
| `0012_inventory_lot_movements.sql`       | `stock_movements.from_stock_lot_id` / `to_stock_lot_id` + bileşik FK (lot AYNI ürün + AYNI lokasyon) + indeksler                                                                                                                                                                                                                              |
| `0013_inventory_lots_security.sql`       | Defter tetikleyicisi lot önbelleği (koşullu düşüm), lot koruma (lot zorunluluğu, SKT / geri çağırma / pasif reddi, transfer kimliği), `lot_expired()` (şube saat dilimi), lot satırı koruması (kimlik değişmez, geri çağırma geri alınamaz), `recompute_stock_lot`, tahsis koruması (yalnızca DRAFT), RLS ENABLE+FORCE, sütun düzeyi yetkiler |
| `0014_notifications_outbox.sql`          | Sprint 6: `notifications`, `notification_preferences`, `outbox_events`, 4 enum, `appointment_approval_mode`, `approval_expires_at`; `appointment_status` + `PENDING_APPROVAL` (tip yeniden oluşturularak — ADD VALUE aynı transaction'da kullanılamadığı için)                                                                                |
| `0015_notifications_security.sql`        | Durum makinesi + çakışma constraint'ları `PENDING_APPROVAL` ile, bildirim / outbox koruma tetikleyicileri, `outbox_ready_tenants()` (yalnızca kiracı kimliği), 3 tabloda RLS ENABLE+FORCE, sütun düzeyi yetkiler                                                                                                                              |
| `0016_voice_assistant.sql`               | Sprint 7: `voice_sessions`, `ai_action_logs`, `pending_ai_actions`, 4 enum, `clinic_profiles.voice_enabled` / `voice_privacy_mode` / `preferred_voice_language`                                                                                                                                                                               |
| `0017_voice_security.sql`                | Etkin idempotency kısmi benzersiz indeksi, bekleyen eylem / AI günlüğü / ses oturumu koruma tetikleyicileri (kimlik + girdi + özet değişmez, durum makinesi, son durumlar değişmez, silme yalnızca imha), 3 tabloda RLS ENABLE+FORCE, sütun düzeyi yetkiler                                                                                   |
| `0018_chat_assistant.sql`                | Sprint 7.2: `audit_source` / `appointment_source` + `AI_CHAT` (ADD VALUE; aynı çalıştırmada kullanılmaz), `voice_sessions.channel` (VOICE / CHAT) + CHECK + indeks                                                                                                                                                                            |
| `0019_chat_security.sql`                 | `voice_sessions_guard`: oturum kanalı (`channel`) kimlik alanı gibi değişmez; uygulama rolünde `channel` UPDATE yetkisi yok                                                                                                                                                                                                                   |
| `0020_clinical_notes.sql`                | Sprint 7.3: `clinical_notes` (muayene kaydı, sürümlü), bileşik kiracı FK (randevu / hasta / doktor / yazar), sürüm benzersizliği, özet CHECK                                                                                                                                                                                                  |
| `0021_clinical_notes_security.sql`       | Yalnızca ekleme tetikleyicisi (UPDATE yok, DELETE yalnızca imha), hasta/doktor = randevununki, sürüm = en büyük + 1, RLS ENABLE+FORCE, uygulama rolü SELECT+INSERT                                                                                                                                                                            |
| `0022_finance.sql`                       | Sprint 8: `patient_charges` (hizmet bedeli), `cash_categories`, `cash_transactions` (kasa / tahsilat), `clinical_services.price_minor` + `currency`; tutarlar kuruş (tamsayı), CHECK'ler (toplam = adet × fiyat − indirim, para birimi, gider hastasız), randevu başına tek aktif otomatik bedel (kısmi benzersiz indeks)                     |
| `0023_finance_security.sql`              | Değiştirilemez defter tetikleyicisi (UPDATE yalnızca ACTIVE → VOIDED, başka sütun değişmez; DELETE yalnızca imha), randevuya bağlı kayıtta hasta / şube tutarlılığı, RLS ENABLE+FORCE, uygulama rolü SELECT+INSERT+UPDATE                                                                                                                     |
| `0024_patient_card.sql`                  | Sprint 8.1: `patient_lookups` (kaynak / özel sigorta tanımları), `patients.source_id`, `insurer_id`, `social_security`, `referral`, `sms_allowed`, `health_profile_encrypted`                                                                                                                                                                 |
| `0025_patient_card_security.sql`         | Hastanın kaynak / sigorta tanımı doğru türde olmalı (tetikleyici), `patient_lookups` RLS ENABLE+FORCE, uygulama rolü SELECT+INSERT+UPDATE                                                                                                                                                                                                     |
| `0026_clinical_attachments.sql`          | Sprint 8.2: `clinical_attachments` (muayene dosyaları: özel depo anahtarı, şifreli ad, tür / boyut / SHA-256 CHECK'leri, geçersiz kılma alanları)                                                                                                                                                                                             |
| `0027_clinical_attachments_security.sql` | Değiştirilemezlik (UPDATE yalnızca ACTIVE → VOIDED, DELETE yalnızca imha), anahtar kiracı önekinde, hasta / doktor = randevununki, RLS ENABLE+FORCE, uygulama rolü SELECT+INSERT+UPDATE                                                                                                                                                       |
| `0028_patient_tasks.sql`                 | Sprint 8.3: `patient_tasks` (hasta görevleri: tür, şifreli başlık / not / sonuç, termin, atanan, durum), `notification_type` += `TASK_ASSIGNED`                                                                                                                                                                                               |
| `0029_patient_tasks_security.sql`        | Kimlik sütunları değişmez, kapanan görev değişmez, DELETE yalnızca imha, randevu hastası tutarlılığı, RLS ENABLE+FORCE, uygulama rolü SELECT+INSERT+UPDATE                                                                                                                                                                                    |
| `0030_lab_results.sql`                   | Sprint 8.4: `lab_panels` (tahlil tipi + JSON parametreler / referans aralıkları), `lab_results` (şifreli değerler, referans dışı sayısı, numune tarihi, geçersiz kılma alanları)                                                                                                                                                              |
| `0031_lab_results_security.sql`          | `lab_results` değiştirilemez (UPDATE yalnızca ACTIVE → VOIDED, DELETE yalnızca imha), randevu hastası tutarlılığı, iki tabloda RLS ENABLE+FORCE, uygulama rolü SELECT+INSERT+UPDATE                                                                                                                                                           |
| `0032_platform.sql`                      | Sprint 9: `users` kullanıcı adı (`username`, `username_normalized`, kiracı içinde tekil), e-posta isteğe bağlı (biri zorunlu), `must_change_password`; RLS dışı `platform_admins`, `platform_sessions`, `platform_audit_logs`                                                                                                                 |
| `0033_platform_security.sql`             | Platform SECURITY DEFINER fonksiyonları (ACTIVE platform oturum özeti doğrulanır): kiracı listesi (yalnızca sayılar), sahip listesi, klinik açma, askıya alma / etkinleştirme, sahip parolası sıfırlama; uygulama rolüne yalnızca EXECUTE + platform tablolarında dar yetki                                                                   |
| `0034_platform_create_tenant_fix.sql`    | `platform_create_tenant` içinde çıktı kolonu `tenant_id` ile `roles.tenant_id` belirsizliği (42702) giderildi                                                                                                                                                                                                                                 |
| `0001_security.sql`                      |                                                                                                                                                                                                                                                                                                                                               | RLS (ENABLE + FORCE) ve politikalar; `audit_logs`, `document_templates`, `patient_documents`, `consent_choices` koruma tetikleyicileri; `current_tenant_id()`, `retention_purge_enabled()` |

## Tablolar

| Tablo                                                     | Kapsam                      | RLS                                                                                                |
| --------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `tenants`                                                 | Platform                    | —                                                                                                  |
| `permissions`, `role_permissions`                         | Platform                    | —                                                                                                  |
| `roles`                                                   | Platform (NULL) + kiracı    | Okuma: platform+kiracı · Yazma: kiracı / `platform_seed`                                           |
| `sessions`                                                | Platform (token özetiyle)   | —                                                                                                  |
| `rate_limits`                                             | Platform                    | —                                                                                                  |
| `branches`, `rooms`, `users`, `user_roles`                | Kiracı                      | FORCE                                                                                              |
| `patients`                                                | Kiracı                      | FORCE                                                                                              |
| `audit_logs`                                              | Kiracı                      | FORCE + append-only                                                                                |
| `document_templates`                                      | Platform (NULL) + kiracı    | Okuma: platform+kiracı · Yazma: kiracı / `platform_seed`                                           |
| `patient_documents`, `consent_choices`                    | Kiracı                      | FORCE + imza sonrası değişmez                                                                      |
| `patient_branches`                                        | Kiracı (hasta ↔ şube)       | FORCE · şube kapsamı buradan hesaplanır                                                            |
| `consent_revocations`                                     | Kiracı                      | FORCE + yalnızca ekleme                                                                            |
| `clinical_services`, `doctor_services`                    | Kiracı                      | FORCE                                                                                              |
| `appointments`                                            | Kiracı                      | FORCE + çakışma constraint'ları + durum tetikleyicisi                                              |
| `appointment_events`                                      | Kiracı                      | FORCE + yalnızca ekleme                                                                            |
| `inventory_*`, `stock_lots`, `service_material_templates` | Kiracı                      | FORCE                                                                                              |
| `stock_movements`                                         | Kiracı                      | FORCE + yalnızca ekleme (defter)                                                                   |
| `stock_balances`                                          | Kiracı                      | FORCE + uygulama yalnızca okur (tetikleyici yazar)                                                 |
| `patient_material_usages` / `_items`                      | Kiracı                      | FORCE + durum makinesi / DRAFT dışı değişmez                                                       |
| `patient_material_usage_allocations`                      | Kiracı                      | FORCE + yalnızca DRAFT iken değişir; bileşik FK (kalem + lot aynı ürün/lokasyon)                   |
| `notifications` (Sprint 6)                                | Kiracı + alıcı (servis)     | FORCE + içerik değişmez; yalnızca durum sütunları güncellenir; silinmez                            |
| `notification_preferences`                                | Kiracı                      | FORCE; silinmez                                                                                    |
| `outbox_events`                                           | Kiracı                      | FORCE + yük değişmez; yalnızca durum / deneme sütunları; silinmez                                  |
| `voice_sessions` (Sprint 7)                               | Kiracı + kullanıcı (servis) | FORCE; yalnızca durum / bitiş / dil güncellenir; istemci sırrı, ses, döküm SAKLANMAZ               |
| `pending_ai_actions`                                      | Kiracı + kullanıcı + oturum | FORCE; girdi AES-GCM şifreli + SHA-256 özet, değişmez; PENDING→CONFIRMED→EXECUTED/FAILED; silinmez |
| `ai_action_logs`                                          | Kiracı                      | FORCE; araç adı / tip / varlık kimliği / güvenli meta — PII yok; son durumlar değişmez; silinmez   |
| `stock_lots` (Sprint 5)                                   |                             | Kiracı                                                                                             | FORCE + `quantity` / `lot_number` uygulama rolünce yazılamaz (sütun yetkisi); silinemez |

## Oturum değişkenleri (transaction'a yerel)

| Değişken                  | Ayarlayan                              | Amaç                       |
| ------------------------- | -------------------------------------- | -------------------------- |
| `app.tenant_id`           | `tenantQuery()`                        | RLS kiracı bağlamı         |
| `kliniva.platform_seed`   | `syncRbacCatalog()`                    | Sistem rollerini yazma     |
| `kliniva.retention_purge` | Denetimli imha işlemi / test temizliği | İmzalı belge + audit silme |

Tümü `set_config(..., true)` ile **transaction'a yereldir**; havuzdaki bağlantıya sızmaz.

## Bağlantı rolleri ve RLS

Tablo sahibi rol RLS'den muaftır (FORCE ile kısmen kapatılır) ve SUPERUSER/BYPASSRLS rol RLS'i tamamen atlar. Bu
yüzden uygulama **asla** sahip rolle çalışmaz:

- `kliniva_app`: SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION **yok**, kliniva nesnelerinin sahibi **değil**,
  kliniva şemasında CREATE **yok**, public şemasına yetki **verilmez**.
- Yetki matrisi (fazlası da eksiği de `db:inspect` hatası): audit_logs SELECT+INSERT · consent_choices SELECT+INSERT ·
  patient_documents / document_templates SELECT+INSERT+UPDATE (tetikleyiciler korur, DELETE yok) · patients, users,
  branches, rooms, patient_branches SELECT+INSERT+UPDATE · consent_revocations SELECT+INSERT · clinical_services, doctor_services, appointments SELECT+INSERT+UPDATE · appointment_events SELECT+INSERT · stock_movements SELECT+INSERT · stock_balances SELECT · inventory_categories/items/locations, stock_lots, patient_material_usages SELECT+INSERT+UPDATE · patient_material_usage_items, service_material_templates CRUD · user_roles SELECT+INSERT+DELETE · sessions SELECT+INSERT+UPDATE ·
  rate_limits CRUD · tenants SELECT + yalnızca `patient_seq, updated_at` UPDATE · roles/permissions/role_permissions SELECT.
- Üretimde uygulama açılışta rolünü denetler (`src/instrumentation.ts`); güvensizse **başlamaz**.
- İmzalı belgeler: `patient_documents` → `patients` / `branches` / `document_templates` FK'ları **NO ACTION**
  (CASCADE yok). Hasta veya kiracı silinmeye çalışılırsa imzalı belge kaybolmaz; silme reddedilir.

## Entegrasyon testleri ve veri

Testler rastgele `t-test-*` slug'lı geçici kiracılar oluşturur, sonunda yasal imha yoluyla siler. Gerçek
şifreleme anahtarı yerine her çalıştırmada geçici test anahtarı kullanılır.
