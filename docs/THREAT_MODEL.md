# Tehdit Modeli — Kliniva AI (Sprint 0)

Yöntem: STRIDE, varlık odaklı. Kapsam: web uygulaması, API, veritabanı, özel depo.

## Varlıklar

| Varlık                                          | Sınıf                   | Etki (ihlal)                                |
| ----------------------------------------------- | ----------------------- | ------------------------------------------- |
| Hasta sağlık verisi (notlar, imzalı belgeler)   | HEALTH_SPECIAL_CATEGORY | Çok yüksek — KVKK m.6, itibar, hasta zararı |
| Hasta kimlik / iletişim                         | PERSONAL                | Yüksek                                      |
| İmza görüntüsü                                  | SENSITIVE_PERSONAL      | Yüksek                                      |
| Oturum token'ları, MFA sırları, parola özetleri | SENSITIVE_PERSONAL      | Yüksek — hesap ele geçirme                  |
| `DATABASE_URL`, `APP_ENCRYPTION_KEY`            | Sır                     | Kritik — tüm veri                           |
| Audit log                                       | INTERNAL                | Orta — inkâr edilemezlik                    |

## Güven sınırları

1. Tarayıcı ↔ Next.js sunucusu (HTTPS, çerez, CSP)
2. Sunucu ↔ Neon PostgreSQL (TLS, RLS)
3. Sunucu ↔ özel depo (uygulama içi şifreleme)
4. Kiracı ↔ kiracı (aynı veritabanı, mantıksal izolasyon)
5. (Gelecek) Sunucu ↔ AI sağlayıcısı

## STRIDE

| #   | Tehdit          | Senaryo                                      | Önlem                                                                         | Doğrulama                          |
| --- | --------------- | -------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------- |
| S1  | Spoofing        | Kaba kuvvet parola denemesi                  | Argon2id, hesap+IP rate limit, genel hata                                     | `auth.test.ts` rate limit          |
| S2  | Spoofing        | Session fixation                             | Girişte yeni token, eski token iptal, MFA sonrası rotasyon                    | `auth.test.ts`                     |
| S3  | Spoofing        | Çalınan çerez                                | HttpOnly, Secure, SameSite=Lax, 60 dk idle, sunucu tarafı iptal               | `auth.test.ts` logout              |
| S4  | Spoofing        | MFA atlatma                                  | MFA_PENDING oturum hiçbir kaynağa erişemez; bypass yok; replay koruması       | `auth.test.ts` MFA                 |
| T1  | Tampering       | İmzalı belgenin değiştirilmesi               | DB tetikleyicisi (UPDATE/DELETE yasak), PDF SHA-256, depoda "wx"              | `documents.test.ts`                |
| T2  | Tampering       | Şablon metninin geriye dönük değişmesi       | Yayımlanmış şablon değişmez; yeni versiyon                                    | `documents.test.ts`                |
| T3  | Tampering       | Şifreli notun başka satıra kopyalanması      | AES-GCM AAD (kiracı+hasta)                                                    | `crypto.test.ts`                   |
| T4  | Tampering       | CSRF                                         | SameSite=Lax, Server Action origin kontrolü, route handler `assertSameOrigin` | `rbac.test.ts`, birim              |
| R1  | Repudiation     | "Ben görmedim / imzalamadım"                 | Aynı transaction'da append-only audit, IP özeti, kaynak                       | `audit.test.ts`                    |
| I1  | Info disclosure | Kiracılar arası IDOR                         | Servis filtresi + RLS FORCE + bileşik FK + 404                                | `tenant-isolation.test.ts`         |
| I2  | Info disclosure | Resepsiyonun tıbbi notu görmesi              | `patient.health.read` ayrı yetki; alan hiç dönmez                             | `rbac.test.ts`                     |
| I3  | Info disclosure | Log/hata izlemeye PHI sızması                | Log temizleyici, audit metadata filtresi, genel hata yanıtı                   | `logging.test.ts`, `audit.test.ts` |
| I4  | Info disclosure | Sırların istemci paketine girmesi            | `server-only`, ESLint sınırı, build sonrası tarama                            | `test:bundle`                      |
| I5  | Info disclosure | İmza/PDF'in public URL ile erişimi           | Özel depo, yetkili uç, `no-store`                                             | `documents.test.ts`                |
| I6  | Info disclosure | XSS ile veri çalma                           | React kaçışı, `dangerouslySetInnerHTML` yasak (ESLint), nonce'lu CSP          | E2E CSP                            |
| I7  | Info disclosure | Clickjacking                                 | `frame-ancestors 'none'`, `X-Frame-Options: DENY`                             | E2E                                |
| D1  | DoS             | Giriş uç noktasına yük                       | Rate limit; (Sprint 1+) WAF/edge rate limit                                   | —                                  |
| D2  | DoS             | Büyük imza/PDF yükü                          | İmza 300 KB / 2000×1000 sınırı, Zod uzunluk sınırları                         | `documents.test.ts`                |
| E1  | Elevation       | Rol atamada yetki yükseltme                  | Alt küme kuralı, PLATFORM_SUPER_ADMIN atanamaz, kendi rolünü değiştiremez     | `rbac.test.ts`                     |
| E2  | Elevation       | Şube müdürünün başka şubeye erişimi          | Şube kapsamı (servis + liste filtresi)                                        | `rbac.test.ts`                     |
| E3  | Elevation       | SQL injection                                | Drizzle parametreli sorgular; ham SQL yalnızca `sql\`\`` parametreli          | Kod incelemesi, Zod                |
| E4  | Elevation       | (Gelecek) AI aracının fazla yetki kullanması | AI araçları kullanıcının AuthContext'i ile çalışır                            | Sprint AI                          |

## Kabul edilen / açık riskler

- Uygulama tek veritabanı rolüyle bağlanır; rol tablo sahibi olduğu için RLS `FORCE` ile uygulanır. Ayrı, sahip
  olmayan uygulama rolü (en az yetki) Sprint 1'de önerilir.
- Özel depo üretim adaptörü (S3/R2) Sprint 1+; geliştirmede yerel şifreli disk.
- WAF / bot koruması ve merkezi hata izleme (PII temizleyicisiyle) Sprint 1+.
