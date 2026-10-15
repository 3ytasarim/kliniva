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

## Sprint 5+ (öneri)

Lot bazlı tüketim + SKT/FEFO, Voice AI (yetki kontrollü araçlar, `source = AI_VOICE`), raporlama, KVKK m.11 bilgi talebi
dışa aktarımı ve düzeltme akışı, MFA zorunluluğu, orphan depo nesnesi temizliği.
