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

| Dosya                            | İçerik                                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000_init.sql`                  | `kliniva` şeması, 6 enum, 15 tablo, bileşik FK'ler, benzersiz kısıtlar, indeksler                                                                                                                                          |
| `0002_app_role.sql`              | `kliniva_app` (NOLOGIN, tehlikeli öznitelik yok) + tablo bazlı yetki matrisi; PLATFORM_SUPER_ADMIN atama yasağı tetikleyicisi                                                                                              |
| `0003_scheduling.sql`            | Sprint 1: 8 yeni tablo, branches/rooms genişletme, rooms.type → enum (veri eşlemeli dönüşüm), kiracı güvenli bileşik FK'ler                                                                                                |
| `0004_scheduling_security.sql`   | btree_gist (kliniva şemasında), 5 exclusion constraint (çakışma motoru), 8 tabloda RLS ENABLE+FORCE, kliniva_app yetkileri                                                                                                 |
| `0005_patient_crm.sql`           | Sprint 2: `patient_branches`, `consent_revocations`, hasta iletişim/normalize alanları, şifreli TC kimlik, belge snapshot + VOID alanları, `signer_type`, `GENERATED → DRAFT` (RENAME VALUE, veri korunur), hasta no öneki |
| `0006_patient_crm_security.sql`  | Belge durum makinesi tetikleyicisi (yeniden yazıldı), rıza geri çekme tetikleyicisi, 2 tabloda RLS ENABLE+FORCE, yetkiler, `patient_branches` ve normalize telefon/e-posta geri doldurma                                   |
| `0007_appointments.sql`          | Sprint 3: `clinical_services`, `doctor_services`, `appointments`, `appointment_events`, 3 enum, randevu yapılandırması (`clinic_profiles`), indeksler                                                                      |
| `0008_appointments_security.sql` | Doktor / oda / hasta `tstzrange` exclusion constraint'ları, durum makinesi tetikleyicisi, geçmiş append-only, 4 tabloda RLS ENABLE+FORCE, yetkiler                                                                         |
| `0001_security.sql`              | RLS (ENABLE + FORCE) ve politikalar; `audit_logs`, `document_templates`, `patient_documents`, `consent_choices` koruma tetikleyicileri; `current_tenant_id()`, `retention_purge_enabled()`                                 |

## Tablolar

| Tablo                                      | Kapsam                    | RLS                                                      |
| ------------------------------------------ | ------------------------- | -------------------------------------------------------- |
| `tenants`                                  | Platform                  | —                                                        |
| `permissions`, `role_permissions`          | Platform                  | —                                                        |
| `roles`                                    | Platform (NULL) + kiracı  | Okuma: platform+kiracı · Yazma: kiracı / `platform_seed` |
| `sessions`                                 | Platform (token özetiyle) | —                                                        |
| `rate_limits`                              | Platform                  | —                                                        |
| `branches`, `rooms`, `users`, `user_roles` | Kiracı                    | FORCE                                                    |
| `patients`                                 | Kiracı                    | FORCE                                                    |
| `audit_logs`                               | Kiracı                    | FORCE + append-only                                      |
| `document_templates`                       | Platform (NULL) + kiracı  | Okuma: platform+kiracı · Yazma: kiracı / `platform_seed` |
| `patient_documents`, `consent_choices`     | Kiracı                    | FORCE + imza sonrası değişmez                            |
| `patient_branches`                         | Kiracı (hasta ↔ şube)     | FORCE · şube kapsamı buradan hesaplanır                  |
| `consent_revocations`                      | Kiracı                    | FORCE + yalnızca ekleme                                  |
| `clinical_services`, `doctor_services`     | Kiracı                    | FORCE                                                    |
| `appointments`                             | Kiracı                    | FORCE + çakışma constraint'ları + durum tetikleyicisi    |
| `appointment_events`                       | Kiracı                    | FORCE + yalnızca ekleme                                  |

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
  branches, rooms, patient_branches SELECT+INSERT+UPDATE · consent_revocations SELECT+INSERT · clinical_services, doctor_services, appointments SELECT+INSERT+UPDATE · appointment_events SELECT+INSERT · user_roles SELECT+INSERT+DELETE · sessions SELECT+INSERT+UPDATE ·
  rate_limits CRUD · tenants SELECT + yalnızca `patient_seq, updated_at` UPDATE · roles/permissions/role_permissions SELECT.
- Üretimde uygulama açılışta rolünü denetler (`src/instrumentation.ts`); güvensizse **başlamaz**.
- İmzalı belgeler: `patient_documents` → `patients` / `branches` / `document_templates` FK'ları **NO ACTION**
  (CASCADE yok). Hasta veya kiracı silinmeye çalışılırsa imzalı belge kaybolmaz; silme reddedilir.

## Entegrasyon testleri ve veri

Testler rastgele `t-test-*` slug'lı geçici kiracılar oluşturur, sonunda yasal imha yoluyla siler. Gerçek
şifreleme anahtarı yerine her çalıştırmada geçici test anahtarı kullanılır.
