# Proje Planı — Kliniva AI

## Sprint 0 — Güvenli temel altyapı (bu sprint)

Öncelik sırası: güvenlik → kiracı izolasyonu → kullanıcı/yetki → KVKK belge altyapısı → audit → mevcut Neon bağlantısı.

| İş                                                                                  | Durum |
| ----------------------------------------------------------------------------------- | ----- |
| Next.js 16 + TS strict + Tailwind v4 + Drizzle + Zod + Vitest + Playwright iskeleti | ✅    |
| Çok kiracılı şema (`kliniva` şeması), RLS FORCE, bileşik FK                         | ✅    |
| Argon2id auth, sunucu tarafı oturum, rotasyon, rate limit, TOTP MFA                 | ✅    |
| RBAC kataloğu + şube kapsamı + yetki yükseltme koruması                             | ✅    |
| Hasta temel modeli + şifreli tıbbi not                                              | ✅    |
| AES-256-GCM alan şifreleme servisi                                                  | ✅    |
| Append-only audit log                                                               | ✅    |
| KVKK şablon versiyonlama, belge, seçim, statik imza, imzalı PDF + SHA-256           | ✅    |
| Güvenlik başlıkları (nonce CSP), PII/PHI-safe logging                               | ✅    |
| Dokümantasyon + testler                                                             | ✅    |

## Sprint 1 — Klinik profili ve planlama ✅

Klinik profili + logo, şubeler, odalar, doktorlar, çalışma saatleri, çakışma motoru (exclusion constraint),
müsaitlik hesabı. Ayrıntı: `docs/SCHEDULING.md`.

## Sprint 2 — Hasta CRM + KVKK + açık rıza + statik imza ✅

| İş                                                                                        | Durum |
| ----------------------------------------------------------------------------------------- | ----- |
| Hasta modeli: iletişim alanları, E.164 telefon, şifreli TC kimlik, `patient_branches`     | ✅    |
| Eşzamanlılık güvenli hasta no (`KLI-000001`, kiracı öneki)                                | ✅    |
| Deterministik mükerrer uyarısı (birleştirme yok)                                          | ✅    |
| `/patients` arama + sayfalama, `/patients/new` 5 adımlı sihirbaz, hasta dosyası sekmeleri | ✅    |
| Tablet odak imza ekranı, `/settings/documents` şablon sürümleri                           | ✅    |
| Şifreli snapshot + TOCTOU koruması, durum makinesi tetikleyicisi, VOID                    | ✅    |
| PDF v2 (header/footer, sayfalama, bölünmeyen imza bloğu, logo / metin başlık)             | ✅    |
| Bütünlük doğrulama, dosya uç noktası, özel depo (local + S3/R2 SigV4)                     | ✅    |
| Rıza durumu (GRANTED/DENIED/REVOKED/NOT_ASKED) ve geri çekme                              | ✅    |

## Sprint 3 — Randevu motoru ✅

Klinik hizmetleri + doktor-hizmet eşleşmesi, uygunluk motoru (oda tahsisi dahil), doktor/oda/hasta çakışma
motoru (servis + exclusion constraint), eşzamanlı rezervasyon güvenliği, atomik taşıma, durum makinesi (DB
tetikleyicisi), takvim (gün/hafta), yeni randevu akışı, randevu detayı, doktor portalı bugünkü liste, panel kartları,
hasta dosyası randevular sekmesi, Sprint 1 izin/oda düzeltmesi. Ayrıntı: `docs/APPOINTMENTS.md`.

## Sprint 4 — Stok ve hasta malzeme kullanımı ✅

Ürün / kategori / lokasyon (şube deposu + oda), değişmez stok defteri ve tetikleyiciyle bakiye, ilk stok / alım /
düzeltme / atomik transfer, şubeler arası transfer yetkisi, hasta malzeme kullanımı (taslak → kesinleştir → VOID),
hizmet malzeme şablonu (öneri), kritik stok, uzlaştırma, lot/SKT temeli. Ayrıntı: `docs/INVENTORY.md`.

## Sprint 5 — Lot / parti, SKT, FEFO ve stok güvenliği ✅

Lot takip bayrakları ve mod kuralları, lotlu giriş / transfer (kimlik korunur), FEFO tahsisi (çoklu lot) ve elle
seçim, SKT anlamı (şube yerel günü sonuna kadar), kullanılabilir vs fiziksel stok, hasta lot izlenebilirliği, geri
çağırma (geri alınamaz), imha, fiziksel sayım, SKT raporu ve panel kartları, eşzamanlılık + DB havuzu yük testi.
Ayrıntı: `docs/INVENTORY.md`.

## Sprint 6 — Bildirim merkezi, outbox, gerçek zamanlı operasyon, doktor onayı ✅

Uygulama içi bildirimler (zil + sayfa + tercihler), transactional outbox (SKIP LOCKED, tekilleştirme, yeniden deneme,
başarısız olay ekranı), SSE gerçek zamanlı akış, Bugünkü operasyon ekranı, doktor onay modu (PENDING_APPROVAL slot
tutar), stok eşik / SKT / geri çağırma / belge bütünlüğü uyarıları. Ayrıntı: `docs/NOTIFICATIONS.md`.

## Sprint 7 — Kliniva AI sesli asistan ✅

OpenAI Realtime (WebRTC) üzerinden Türkçe sesli klinik operasyon asistanı: sunucuda kısa ömürlü istemci sırrı (ana
anahtar tarayıcıya gitmez), 19 dar kapsamlı araç (mevcut servisler, mevcut RBAC / RLS / şube / doktor kapsamı), açık
onaylı yazma eylemleri (PendingAIAction: 2 dk, aynı kullanıcı + oturum, şifreli + özetli değişmez girdi,
idempotency), `AI_VOICE` kaynaklı audit, ölçülü gizlilik modu, tıbbi karar sınırı, sahte taşıyıcı + metin düzeneği.
Ayrıntı: `docs/VOICE.md`.

## Sprint 7.2 — Tasarım sistemi v2 ve yazılı sohbet asistanı ✅

Tasarım sistemi v2: Inter (kendi sunucumuzdan), yüzey / kenarlık / gölge token'ları, shadcn/ui tarzı bileşenler
(Button, Card, Tabs, DropdownMenu, Popover, Calendar, Tooltip), lucide simgeler; CSP uyumlu (Radix menüler modal=false →
<style> enjeksiyonu yok). Gruplu kenar menü + üst çubuk; yeni Panel, Bugünkü muayeneler, Randevu takvimi (mini takvim,
filtre menüleri, avatarlı doktor sütunları, durum renkli etkinlikler, şimdi çizgisi), Hastalar, hasta profili, Planım.
"Operasyon" → "Muayene" terminolojisi (tüm roller). Kliniva AI paneli: Yazışma (sunucu tarafı model + aynı 19 araç +
aynı onay) ve Sesli sekmeleri; yazılı sohbet kaynağı `AI_CHAT`. Ayrıntı: `docs/VOICE.md`.

## Sprint 7.3 — Muayene kaydı ✅

Randevu detay sayfası yenilendi (üst kart, ilerleme adımları, iki sütun). Doktor, hasta geldikten sonra kendi
randevusuna muayene kaydı yazar (şikâyet, bulgular, yapılan işlemler, plan): şifreli, sürümlü, yalnızca ekleme;
yönetici okur ama yazamaz, resepsiyon göremez. Migration 0020–0021.

## Sprint 8 — Hasta hesabı ve kasa ✅

Hekim Rehberi karşılaştırmasından çıkan 1. ve 2. madde. Hizmetlere fiyat + para birimi; randevu TAMAMLANINCA hizmet
bedeli otomatik hasta hesabına yansır (randevu başına tek). Hasta dosyasında "Hesap" sekmesi ve randevu sayfasında
"Ücret ve tahsilat": elle bedel (adet, indirim), tahsilat (nakit / kart / havale / diğer), bakiye. Kasa: hastasız
gelir / gider, kategoriler, dönem özetleri (7 gün / ay / yıl / toplam), hareket listesi. Açık bakiyeler listesi.
Panel: bu ay tahsilat (geçen ayın aynı dönemine göre), açık bakiye, bu ay kasa, son 6 ay gelir-gider grafiği, en çok
ciro yapan hizmetler, borçlu hastalar. Kayıtlar DEĞİŞTİRİLEMEZ: yalnızca gerekçeli iptal (DB tetikleyicisi). Yetkiler:
`billing.read/charge/payment/void`, `cash.read/manage` (resepsiyon: görüntüle + bedel + tahsilat; doktor: yok).
Migration 0022–0023.

## Sprint 8.1 — Hasta kartı ve liste segmentleri ✅

Hekim Rehberi karşılaştırmasının 3. maddesi. Kiracıya özel hasta tanımları (kaynak, özel sigorta; Ayarlar → Hasta
tanımları), hasta kartında kaynak / yönlendiren / sosyal güvence / özel sigorta / SMS izni. Şifreli sağlık profili
(kan grubu, alerjiler, kronik hastalıklar, ilaçlar, sigara, alkol) — alerji hasta başlığında ve randevu (muayene)
ekranında uyarı olarak. Hasta listesi: özet kartları, segmentler (yaklaşan randevulu, açık bakiyeli, 90+ gündür
gelmeyen, tekrar gelen, hiç ziyareti yok, bu ay kayıt), kaynak filtresi; son ziyaret / ziyaret sayısı / sonraki
randevu / bakiye sütunları. Panel: hasta kaynakları (son 90 gün ziyaret). Migration 0024–0025.

## Sprint 8.2 — Muayene kaydı alanları ve dosyalar ✅

Hekim Rehberi karşılaştırmasının 4. maddesi. Muayene kaydına "Öykü / geçmiş" ve "Hastaya tavsiyeler" alanları
(eski sürümler boş alanla okunur); alerjiler hasta sağlık profilinden gelir ve muayene ekranında uyarı olarak görünür.
Muayeneye şifreli dosya ekleme (tahlil sonucu, fotoğraf, PDF): tür içerikten doğrulanır, en çok 5 MB, randevu başına
20; indirme yetki kontrollü uç (`/api/v1/clinical-attachments/:id`), bütünlük doğrulaması ve audit; silinmez,
gerekçeyle geçersiz kılınır. Migration 0026–0027. Açık konu: yükleme sonrası kayıt başarısız olursa depoda yetim
nesne kalabilir (yetim nesne temizliği bakım işi).

## Sprint 8.3 — Hasta görevleri ✅

Hekim Rehberi karşılaştırmasının 5. maddesi. Hastaya bağlı arama / e-posta / SMS / görüşme görevleri: tür, başlık,
termin, atanan kişi, not; sonuç (Tamamlandı / Ulaşılamadı / İptal + not) ve geri açılamaz kapanış. Atama yalnızca o
şubede görev görebilen aktif kullanıcıya; başkasına atanınca uygulama içi bildirim (TASK_ASSIGNED, metinde hasta /
başlık yok). Görünürlük: doktor / asistan kendi görevleri, resepsiyon / yönetim şube kapsamındaki tümü
(`task.read`, `task.create`, `task.manage`). Görevler sayfası (açık / geciken / bugün / kapanan), hasta dosyasında
Görevler sekmesi, panelde "Bana atanmış işler". Migration 0028–0029.

## Sprint 8.4 — Tahliller ✅

Hekim Rehberi karşılaştırmasının 6. maddesi. Tahlil tipleri (Ayarlar → Tahlil tipleri; "Ad | birim | alt | üst"
satırlarıyla parametreler ve referans aralıkları). Hasta dosyasında Tahliller sekmesi: tip seçip numune tarihi ve
değerleri girme, aralık dışı değerlerin ↑/↓ işaretlenmesi, tip başına son 6 sonucun değişim tablosu, sonuç listesi.
Sonuç girildiği andaki ad / birim / aralık sonuçta saklanır (tip sonradan değişse de eski sonuç değişmez). Değerler
şifreli; düzeltme yok, gerekçeyle geçersiz kılınır. Yetki: tip yönetimi `clinic.manage`, sonuç
`patient.health.write` / `patient.health.read`. Migration 0030–0031.

## Sprint 9 — Platform yönetimi (klinik açma) ✅

Programı satan taraf için ayrı platform paneli (`/platform`): ayrı çerez, 8 saat / 30 dk boşta oturum, iki adımlı
doğrulama zorunlu. Platform yöneticisi yalnızca sunucuda komutla açılır (`npm run platform:admin`, parola ortam
değişkeninden). Yeni klinik: rastgele klinik kodu (`kl-xxxxxx`), "Merkez" şubesi, klinik profili, varsayılan hasta
kaynakları ve kasa kategorileri, klinik yöneticisi (kullanıcı adı veya e-posta + geçici parola). Geçici parolayla
giren kullanıcı önce parolasını değiştirmek zorundadır (`/account/password`); personel de kullanıcı adıyla açılabilir.
Klinik askıya alma / etkinleştirme (oturumlar düşer), yönetici parolası sıfırlama. Platform hasta verisi görmez;
tüm işlemler oturum doğrulayan DB fonksiyonlarıyla. Migration 0032–0034.

## Sprint 8+ (öneri)

Hekim Rehberi karşılaştırması sırası (1–6 tamam): (7) hasta bildirimleri (SMS / WhatsApp — sağlayıcı kararı gerekli), (8) online randevu
talepleri.

Gerçek OpenAI anahtarıyla saha doğrulaması (WebRTC, barge-in, gürültü), raporlama, KVKK m.11 bilgi talebi
dışa aktarımı ve düzeltme akışı, MFA zorunluluğu, orphan depo nesnesi temizliği.
