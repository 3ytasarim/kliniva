# Doktor Planlama ve Müsaitlik Temeli — Kliniva AI (Sprint 1)

## Model

| Tablo                        | Amaç                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `clinic_profiles`            | Kiracı başına tek profil; logo özel depoda (`logoStorageKey`)        |
| `branch_working_hours`       | Şube açılış saatleri (şube + gün benzersiz)                          |
| `branch_closures`            | Şube kapalı günleri (tüm gün / saat aralığı)                         |
| `doctor_profiles`            | Kullanıcıdan ayrı doktor profili (`user_id` benzersiz)               |
| `doctor_branches`            | Doktor ↔ şube (çalışma saati / oda ataması bu bağa FK ile bağlıdır)  |
| `doctor_working_hours`       | Haftalık çalışma blokları (gün başına birden çok blok)               |
| `doctor_room_assignments`    | Haftalık (`day_of_week`) VEYA tarihli (`effective_date`) oda ataması |
| `doctor_schedule_exceptions` | İzin / çalışmama (tüm gün / saat aralığı; şube veya tüm şubeler)     |

Gün: ISO-8601 (1 = Pazartesi … 7 = Pazar). Saatler şubenin yerel saatidir. Aralıklar yarı açık `[başlangıç, bitiş)`:
09:00–12:00 ile 12:00–15:00 çakışmaz.

## Çakışma motoru

1. **Servis katmanı** (`src/server/services/schedule.ts`): transaction + `pg_advisory_xact_lock` (doktor ve oda başına,
   deterministik sırayla) + örtüşme sorgusu. Kullanıcıya anlamlı ve yalnızca aynı kiracıya ait mesaj döner
   ("Bu oda 09:00–12:00 arasında Dr. Ahmet Yılmaz tarafından kullanılıyor."). Haftalık ↔ tarihli çapraz kurallar
   burada uygulanır.
2. **Veritabanı** (`0004_scheduling_security.sql`): `btree_gist` (kliniva şemasında) ile 5 exclusion constraint —
   aynı doktor/gün çalışma bloğu, aynı oda/gün, aynı doktor/gün oda, aynı oda/tarih, aynı doktor/tarih. Servis
   atlansa veya iki istek yarışsa bile örtüşme imkânsızdır (`23P01` → `*_SCHEDULE_CONFLICT`).

Kurallar: doktor aynı anda iki şubede/odada olamaz; oda aynı anda iki doktora verilemez; oda ataması doktorun o
şube/gündeki çalışma bloğunun içinde olmalıdır; tarihli override doktorun o tarih/saatteki haftalık atamasının
yerine geçer (boşalttığı oda o aralıkta başka doktora verilebilir).

## Müsaitlik temeli

`resolveDoctorAvailabilityBase(ctx, { doctorId, branchId, date })`:

```
çalışma blokları ∩ şube saatleri (etkinse) − doktor izinleri − şube kapanışları
→ oda segmentleri: tarihli override > haftalık atama > oda atanmamış
→ her pencere yerel "HH:MM" + UTC ISO (IANA saat dilimi; sabit +03:00 yok)
```

Sprint 2'de randevular bu pencerelerden düşülecektir. Saf hesaplama `src/server/scheduling/availability.ts`,
saat dilimi yardımcıları `src/lib/time.ts` (yaz saati geçişleri test edildi).

## Yetki

| Rol                   | Plan okuma                       | Plan yönetimi         | Doktor profili / şube atama    |
| --------------------- | -------------------------------- | --------------------- | ------------------------------ |
| CLINIC_OWNER          | ✓                                | ✓                     | ✓ (+ yeni doktor kullanıcısı)  |
| CLINIC_ADMIN          | ✓                                | ✓                     | ✓ (yeni DOCTOR kullanıcısı ✗¹) |
| BRANCH_MANAGER        | yalnızca kendi şubesi            | yalnızca kendi şubesi | ✗                              |
| RECEPTION / ASSISTANT | ✓                                | ✗                     | ✗                              |
| DOCTOR                | yalnızca kendi planı (`/doctor`) | ✗                     | ✗                              |

¹ DOCTOR rolü hasta sağlık verisi yetkisi içerir; yetki yükseltme kuralı gereği bu yetkiye sahip olmayan bir yönetici
DOCTOR rolünü atayamaz (kendine doktor hesabı açarak sağlık verisine ulaşamaz). CLINIC_ADMIN, DOCTOR rolündeki
mevcut kullanıcılar için profil oluşturabilir ve planları yönetebilir.

## Logo

PNG / JPEG / WEBP, ≤ 5 MB. İçerik magic bytes ile tanınır (uzantı/MIME'a güvenilmez), sharp ile gerçekten decode
edilir, EXIF yönü uygulanır, metadata atılır, en çok 1024 px PNG'ye yeniden kodlanır. SVG reddedilir. Anahtar
`<tenantId>/logos/<uuid>.png`; orijinal dosya adı saklanmaz. `GET /api/v1/clinic/logo` parametre almaz — yalnızca
oturumdaki kiracının logosu. İmzalı PDF üreticisi logo, ticari unvan ve şube adresini kullanır.
