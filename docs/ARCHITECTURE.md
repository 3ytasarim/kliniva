# Mimari — Kliniva AI

## Hiyerarşi

```
Platform
  └─ Tenant (Klinik)                 tenants
       ├─ Branch (Şube)              branches
       │    ├─ Room                  rooms
       │    ├─ (Sprint 1+) Appointment, Inventory
       ├─ User + UserRole(branch?)   users, user_roles
       ├─ Patient                    patients
       ├─ DocumentTemplate (versiyon) document_templates  (tenant_id NULL = platform şablonu)
       │    └─ PatientDocument       patient_documents
       │         └─ ConsentChoice    consent_choices
       └─ AuditLog                   audit_logs
```

## Katmanlar

```
src/app            Sayfalar (Server Components), Server Actions, Route Handlers (/api/v1)
  │                 yalnızca: requireUser() / requireUserFromRequest() → servis çağrısı
src/server/services İş kuralları: requirePermission → Zod → tenantQuery → writeAudit
src/server/auth     Oturum, login/MFA, AuthContext, RBAC kataloğu
src/server/tenant   tenantQuery / tenantWhere / withTenant (tek kiracı erişim noktası)
src/server/security Şifreleme, parola, TOTP, rate limit, origin, istek meta verisi
src/server/db       Drizzle şeması + ham istemci (yalnızca altyapı katmanları import edebilir)
src/server/log      Yapılandırılmış logger + PII/PHI temizleyici
src/server/storage  Özel (private) şifreli nesne deposu
src/server/documents İmza temizleme, imzalı PDF üretimi
```

Tüm `src/server/**` modülleri `import "server-only"` ile işaretlidir; istemci paketine girerse build kırılır.
İstemci bileşenleri (`src/components`) `@/server/*` import edemez (ESLint).

## İstek akışı

```
Tarayıcı ──► proxy.ts (nonce + CSP) ──► Sayfa / Action / Route
                                         │ requireUser(): çerez → sessions(token_hash) → AuthContext
                                         ▼
                                       Servis: requirePermission(ctx, "patient.read")
                                         │ Zod parse (yalnızca alan adı hata döner)
                                         ▼
                                       tenantQuery(ctx, scope => …)
                                         │ BEGIN; set_config('app.tenant_id', ctx.tenantId, true)
                                         │ sorgu + tenantWhere(table, scope, …)   ← açık filtre
                                         │ RLS politikası tenant_id = app.tenant_id ← DB filtresi
                                         │ writeAudit(scope, …)                    ← aynı transaction
                                         ▼ COMMIT
```

## Kiracı izolasyonu (savunma derinliği)

| Katman     | Mekanizma                                                              | Neyi engeller                    |
| ---------- | ---------------------------------------------------------------------- | -------------------------------- |
| Kod yapısı | Ham `db` ESLint ile yasak; Drizzle'a şema verilmedi (`db.query.*` yok) | Filtresiz sorgu yazmayı          |
| Servis     | `tenantWhere()` + `withTenant()`; tenantId yalnızca oturumdan          | Uygulama hatalarını              |
| İlişki     | Bileşik FK `(tenant_id, branch_id)` vb.                                | Kiracılar arası referansı        |
| Veritabanı | RLS `ENABLE` + `FORCE`; bağlamsız sorgu 0 satır                        | Unutulmuş filtreyi, SQL hatasını |

Platform tabloları (RLS dışı): `tenants`, `sessions` (token özetiyle aranır), `rate_limits`, `permissions`,
`role_permissions`. `roles` ve `document_templates` platform satırlarını (tenant_id NULL) **okunur** yapar ama
kiracı bağlamından yazılamaz.

## Kimlik doğrulama

- Giriş: klinik kodu (slug) + e-posta + parola. Hata mesajı her durumda aynı.
- Oturum: 256-bit token çerezde; DB'de SHA-256 özeti. 12 saat mutlak, 60 dk boşta zaman aşımı.
- Çerez: `HttpOnly`, `SameSite=Lax`, `Path=/`, üretimde `Secure` + `__Host-` öneki.
- Session fixation: girişte daima yeni token; istemcinin getirdiği eski token iptal; MFA sonrası token tekrar döner.
- Çıkış: `revoked_at` sunucuda set edilir. Kullanıcı pasifleşince / kiracı askıya alınınca oturum bir sonraki
  istekte düşer (AuthContext her istekte yeniden kurulur).

## MFA

TOTP (RFC 6238). Sır şifreli (`two_factor_secret_encrypted`, AAD = kiracı+kullanıcı). MFA etkin kullanıcının
girişi `MFA_PENDING` oturumu üretir; bu oturum hiçbir korunan kaynağa erişemez. Geçerli kod → yeni `ACTIVE` oturum.
Replay koruması: `two_factor_last_used_step`. `MFA_REQUIRED_ROLES` = CLINIC_OWNER, CLINIC_ADMIN, DOCTOR — Sprint 1'de
bu roller için zorunlu kılma (giriş sonrası kurulum zorlaması) eklenecek. Bypass / kurtarma arka kapısı yoktur;
kurtarma kodları Sprint 1'de tek kullanımlık, hash'li olarak eklenecek.

## Yetkilendirme (RBAC)

Katalog: `src/server/auth/permissions.ts` (tek kaynak) → `npm run db:seed` ile DB'ye eşitlenir.
Sağlık verisi ayrı yetkidir (`patient.health.read` / `patient.health.write`): DOCTOR, ASSISTANT (okuma),
CLINIC_OWNER. RECEPTION ve CLINIC_ADMIN varsayılan olarak tıbbi notu görmez (minimum gerekli veri).

## Şifreleme

`encryptField(plaintext, aad)` / `decryptField(payload, aad)` — AES-256-GCM, 12 bayt rastgele IV, 16 bayt tag,
biçim `v1.<iv>.<tag>.<ct>`. İkili veri için `encryptBytes` / `decryptBytes`. HMAC alt anahtarları HKDF ile türetilir
(IP özeti, rate-limit anahtarı). **Anahtar rotasyonu:** yeni anahtar `v2` önekiyle eklenir, okuma her iki versiyonu
destekler, arka plan işi eski kayıtları yeniden şifreler (Sprint 1+). IV başına anahtar ömrü 2^32 şifrelemenin
çok altında tutulur.

## Yapay zekâ güvenlik ilkesi (gelecek — Voice AI)

- AI hiçbir zaman ham SQL / sınırsız DB erişimi almaz.
- AI yalnızca sunucuda tanımlı, Zod şemalı, yetki kontrollü araçları çağırır (`getDoctorAvailability()`,
  `createAppointment()`, `getPatient()`, `recordMaterialUsage()` …). Her araç mevcut servis fonksiyonlarını
  **çağıran kullanıcının AuthContext'i ile** çalıştırır → AI, kullanıcının yetkisinden fazla veri göremez.
- Her AI eylemi `source = "AI_VOICE"` ile audit'lenir (`actorOf(ctx, "AI_VOICE")`).
- AI'ya giden bağlamda sağlık verisi yalnızca `patient.health.read` varsa ve görev gerektiriyorsa bulunur;
  istem/yanıtlar log'lanırken aynı PII/PHI temizleyicisinden geçer.

## Güvenlik başlıkları

`src/lib/security-headers.ts` tek kaynak; `src/proxy.ts` her istekte nonce üretir. Nonce nedeniyle tüm sayfalar
dinamik render edilir (`connection()`), statik HTML üretilmez.
