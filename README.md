# Kliniva AI Projesi

**Kliniva AI** — klinikler için çok kiracılı (multi-tenant), çok şubeli, ileride sesli yapay zekâ destekli klinik
operasyon ve CRM SaaS ürünü.

> Sprint 0: güvenli temel altyapı — kiracı izolasyonu, kimlik doğrulama, RBAC, KVKK belge altyapısı, audit,
> alan şifreleme. Randevu, stok ve Voice AI bu sprintin kapsamı dışındadır.

## Teknoloji

| Katman          | Seçim                                                                       |
| --------------- | --------------------------------------------------------------------------- |
| Uygulama        | Next.js 16 (App Router), React 19, TypeScript (strict)                      |
| Stil            | Tailwind CSS v4                                                             |
| Veritabanı      | **Mevcut** Neon PostgreSQL — `kliniva` şeması                               |
| ORM / migration | Drizzle ORM + drizzle-kit (`generate` + `migrate`; `push` ve shadow DB yok) |
| Doğrulama       | Zod 4                                                                       |
| Parola          | Argon2id (`@node-rs/argon2`)                                                |
| Şifreleme       | AES-256-GCM (Node `crypto`)                                                 |
| PDF             | pdf-lib + Inter (SIL OFL)                                                   |
| Test            | Vitest (birim + entegrasyon + bundle), Playwright (E2E, sistem Edge'i)      |

## Kurulum

```bash
npm install
npm run env:init      # .env.local içine eksik yerel sırları üretir (değerleri yazdırmaz)
```

`.env.local` dosyasına **mevcut** Neon veritabanının **migration** bağlantısını ekleyin (Git'e girmez):

```
MIGRATION_DATABASE_URL=<Neon DIRECT (unpooled) host, şema sahibi rol>
```

Uygulama runtime'ı ayrı, en az yetkili `kliniva_app` rolüyle ve **pooled** host ile bağlanır (`DATABASE_URL`).
Uygulama veritabanı **oluşturmaz**; eksik değişkende yalnızca adını söyler (`DATABASE_URL is required`).

```bash
npm run db:inspect -- --save pre   # SALT OKUNUR ön kontrol; sorun varsa çıkış kodu 1 → DUR
npm run db:migrate                  # yalnızca kliniva şeması; ön/son kontrol + kliniva dışı şema parmak izi
npm run db:app-role                 # kliniva_app: LOGIN + parola (SCRAM); DATABASE_URL yoksa pooled olarak ekler
npm run db:inspect -- --compare pre # kliniva dışında değişiklik olmadığını ve rol güvenliğini doğrular
npm run db:seed                     # RBAC + demo klinik (idempotent; iki kez çalıştırılabilir)
npm run security:check-key          # APP_ENCRYPTION_KEY: biçim, entropi, kaynak/Git/DB taraması (değer yazdırmaz)
npm run dev
```

Giriş: klinik kodu `SEED_TENANT_SLUG`, e-posta `SEED_OWNER_EMAIL`, parola `SEED_OWNER_PASSWORD` (`.env.local`).

## Komutlar

| Komut                      | Açıklama                                                                      |
| -------------------------- | ----------------------------------------------------------------------------- |
| `npm run typecheck`        | TypeScript strict kontrolü                                                    |
| `npm run lint`             | ESLint (ham DB import yasağı dahil)                                           |
| `npm test`                 | Birim testleri (DB gerektirmez)                                               |
| `npm run test:integration` | Entegrasyon testleri — mevcut DB'de geçici test kiracıları oluşturur ve siler |
| `npm run build`            | Üretim build'i                                                                |
| `npm run test:bundle`      | Build sonrası istemci paketinde sır/DB izi taraması                           |
| `npm run test:e2e`         | Playwright duman testleri (build gerekli)                                     |
| `npm run verify`           | Hepsi sırayla                                                                 |

## Ekranlar (Sprint 0)

`/login`, `/login/mfa`, `/dashboard`, `/admin/branches`, `/admin/rooms`, `/admin/users`, `/patients`,
`/settings/security` · API: `/api/v1/patients`, `/api/v1/patients/:id`, `/api/v1/documents/:id/file`

## Dokümantasyon

- [SECURITY.md](SECURITY.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)
- [docs/DATA_CLASSIFICATION.md](docs/DATA_CLASSIFICATION.md)
- [docs/KVKK_ARCHITECTURE.md](docs/KVKK_ARCHITECTURE.md)
- [docs/AUDIT_LOGGING.md](docs/AUDIT_LOGGING.md)
- [docs/DATABASE.md](docs/DATABASE.md)
- [docs/SCHEDULING.md](docs/SCHEDULING.md)
- [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md)

---

3Y Tasarım & Yazılım Hizmetleri
