# Randevu Motoru — Kliniva AI (Sprint 3)

## Model

| Tablo                | Amaç                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `clinical_services`  | Hizmet / işlem tipi: varsayılan süre, oda gerekir mi, izinli oda tipleri (`room_type[]`)      |
| `doctor_services`    | Doktorun verdiği hizmetler (+ doktora özel süre); pasifleştirilir, silinmez                   |
| `appointments`       | Randevu — UTC `timestamptz`, şubenin IANA saat dilimi, şifreli operasyon notu, iptal alanları |
| `appointment_events` | Değişmez geçmiş (CREATED, RESCHEDULED, CONFIRMED, CHECKED_IN, STARTED, COMPLETED, …)          |

`clinic_profiles` yapılandırması: `min_booking_notice_minutes` (0), `max_booking_days_ahead` (365),
`cancellation_reason_required` (true), `slot_interval_minutes` (15).

Süre: istek > doktor override > hizmet varsayılanı > doktor varsayılanı.

## Uygunluk (`getAvailableSlots`)

```
DoctorWorkingHours ∩ BranchWorkingHours − DoctorScheduleExceptions − BranchClosures
− mevcut randevular (doktor + hasta) ∩ uygun oda  = AvailableSlots
```

- **Tek yetkili kaynak sunucudur.** Arayüz saat hesaplamaz; oluşturma ve taşıma aynı hesabı sunucuda tekrarlar,
  istenen başlangıç sunucunun ürettiği slotlardan biri değilse `SLOT_NOT_AVAILABLE`.
- Gün bağlamı **sabit 2 sorgu** ile yüklenir (şube + birleşik JSON sorgusu): çalışma saatleri, şube saatleri,
  kapanışlar, oda atamaları, izinler, odalar ve o güne taşan randevular — doktor/oda sayısından bağımsız (N+1 yok).
- Takvim sorguları tarih penceresiyle yapılır (en fazla 42 gün).
- `reason`: `OK`, `NOT_WORKING`, `DOCTOR_EXCEPTION`, `BRANCH_CLOSED`, `INACTIVE`, `FULLY_BOOKED`, `NO_ROOM`,
  `OUT_OF_RANGE`, `SERVICE_NOT_OFFERED`.

### Oda tahsisi

Hizmet oda gerektiriyorsa, slot ancak şu koşulları sağlayan **en az bir** oda varsa geçerlidir: tipi uygun, aktif,
o aralıkta randevusu yok ve **başka bir doktorun efektif oda atamasında** değil. Doktorun kendi atanmış odası önce
önerilir; kullanıcı listeden başka uygun bir odayı seçebilir.

**Efektif atama** = oda ataması ∩ o doktorun o gün gerçekten çalıştığı süre (izin ve şube kapanışı düşülmüş).
Böylece tüm gün izinli doktorun haftalık odası o gün boştur; 12:00–15:00 izinli doktorun 09:00–17:00 odası
09–12 ve 15–17 dolu, 12–15 boştur (Sprint 1 sınırlamasının düzeltmesi — hem randevu motorunda hem tarihli oda
ataması çakışma kontrolünde).

## Çakışma motoru

1. **Servis:** uygunluk hesabı ayrı bir okuma transaction'ında yapılır; ardından yazma transaction'ı
   advisory lock (doktor, hasta, şube-oda) alır, **tek sorguyla** son kontrolü yapar ve INSERT/UPDATE eder. Kilitli
   bölüm kısa olduğu için eşzamanlı yoğun istekte bağlantı havuzu tükenmez (40 eşzamanlı istek testi).
2. **Veritabanı:** aktif statülerde (`BOOKED, CONFIRMED, CHECKED_IN, IN_PROGRESS, COMPLETED`) üç exclusion
   constraint — aynı doktor, aynı oda, aynı hasta için `tstzrange(start, end, '[)')` örtüşmesi imkânsız.
   Bitişik randevular (`09:00–10:00` / `10:00–11:00`) çakışmaz. `CANCELLED`, `NO_SHOW`, `DRAFT` slot tutmaz.

Hata kodları: `APPOINTMENT_CONFLICT` (doktor), `ROOM_APPOINTMENT_CONFLICT`, `PATIENT_APPOINTMENT_CONFLICT`,
`SLOT_NOT_AVAILABLE`, `APPOINTMENT_IN_PAST`, `BOOKING_OUT_OF_RANGE`, `INVALID_STATUS_TRANSITION`.
Çakışma reddi ayrı transaction'da `APPOINTMENT_CONFLICT` olarak audit'lenir.

## Durum makinesi

```
DRAFT → BOOKED | CANCELLED
BOOKED → CONFIRMED | CHECKED_IN | CANCELLED | NO_SHOW
CONFIRMED → CHECKED_IN | CANCELLED | NO_SHOW
CHECKED_IN → IN_PROGRESS | CANCELLED
IN_PROGRESS → COMPLETED
COMPLETED, CANCELLED, NO_SHOW → (son; hiçbir alan değişmez)
```

Servis (`updateAppointmentStatus`, `cancelAppointment`) ve DB tetikleyicisi (`appointments_guard`) aynı tabloyu
uygular. Ek kurallar: zaman / doktor / oda / şube / hizmet yalnızca `DRAFT/BOOKED/CONFIRMED` iken ve durum
değişmeden değişebilir; `NO_SHOW` randevu saati gelmeden işaretlenemez; iptal gerekçesi (yapılandırmaya göre)
zorunlu; fiziksel silme yok (yalnızca yasal imha). `appointment_events` yalnızca eklenir.

**Taşıma (`rescheduleAppointment`)**: yeni slot doğrulanır, tek UPDATE ile atomik değişir — çakışmada hiçbir şey
değişmez, eski slot ancak yeni yer alınırsa boşalır. Geçmişe `oldStart/oldEnd/newStart/newEnd` (+ oda) yazılır.

## Yetki ve kapsam

| Rol            | Okuma                       | Oluştur / taşı / iptal | Onay | Check-in | Başlat / tamamla | Gelmedi |
| -------------- | --------------------------- | ---------------------- | ---- | -------- | ---------------- | ------- |
| CLINIC_OWNER   | kiracı geneli               | ✓                      | ✓    | ✓        | ✓                | ✓       |
| CLINIC_ADMIN   | kiracı geneli               | ✓                      | ✓    | ✓        | ✓                | ✓       |
| BRANCH_MANAGER | kendi şubesi                | ✓                      | ✓    | ✓        | ✓                | ✓       |
| RECEPTION      | şube kapsamı                | ✓                      | ✓    | ✓        | ✗                | ✗       |
| DOCTOR         | **yalnızca kendi** (`.own`) | ✗                      | ✗    | ✗        | ✓ (kendi)        | ✗       |
| ASSISTANT      | şube kapsamı                | ✗                      | ✗    | ✗        | ✗                | ✗       |
| READ_ONLY      | şube kapsamı                | ✗                      | ✗    | ✗        | ✗                | ✗       |

Kapsam dışı randevu (başka kiracı, başka şube, başka doktor) ID ile istense de `NOT_FOUND` döner (IDOR yok).

## Saat dilimi

Anlar UTC saklanır, arayüzde şubenin IANA saat diliminde gösterilir. Yaz saati geçişinde yaşanmayan
(`NONEXISTENT`) veya iki kez yaşanan (`AMBIGUOUS`) yerel saatlerde slot üretilmez; slotun gerçek süresi (UTC)
hizmet süresine eşit olmalıdır. Europe/Berlin geçiş günleri birim testlerle doğrulanır.

## Voice AI hazırlığı

`src/server/appointments/contracts.ts` — `GetAvailableSlotsInput`, `GetDoctorAvailabilityInput`,
`CreateAppointmentInput`, `RescheduleAppointmentInput`, `CancelAppointmentInput`, `UpdateAppointmentStatusInput`
Zod şemaları. Servisler HTTP/AI bağımsızdır; yapay zekâ ileride yalnızca bu servisleri kullanıcının yetkisiyle
çağıracak (veritabanına doğrudan erişim yok). Bu sprintte ses / AI bağlantısı **yoktur**; `source = AI_VOICE`
henüz kabul edilmez.

## Bildirim

SMS / WhatsApp gönderimi bu sprintte yoktur; `appointment_events` ve servis API'si ileride bildirim için temel
oluşturur.
