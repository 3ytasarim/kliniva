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

## Sprint 1 (öneri)

- MFA zorunluluğu (CLINIC_OWNER/ADMIN/DOCTOR), kurtarma kodları
- Audit görüntüleme ekranı, hasta detay ekranı, tablet imza ekranı (SignaturePad bileşeni hazır)
- Özel depo üretim adaptörü (S3/R2 private), orphan nesne temizliği
- Ayrı en az yetkili uygulama DB rolü
- Randevu modeli (şube + oda + doktor)

## Sprint 2+

Stok, Voice AI (yetki kontrollü araçlar, `source = AI_VOICE`), raporlama, KVKK m.11 hak talepleri.
