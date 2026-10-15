# KVKK Belge Mimarisi — Kliniva AI

> Hukuki not: Bu belge teknik mimariyi açıklar. Aydınlatma ve rıza metinlerinin içeriği kliniğin (veri sorumlusu)
> hukuk danışmanınca onaylanmalıdır. Seed'deki metinler yalnızca şablondur.

## Aydınlatma ≠ Açık Rıza

|                  | Aydınlatma (KVKK m.10) | Açık rıza (KVKK m.3, m.6)                                                           |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| Belge tipi       | `KVKK_DISCLOSURE`      | `EXPLICIT_CONSENT` (ayrıca `COMMERCIAL_COMMUNICATION_CONSENT`, `TREATMENT_CONSENT`) |
| Seçim türü       | `ACKNOWLEDGEMENT`      | `CONSENT`                                                                           |
| Kaydedilen değer | `READ_AND_INFORMED`    | `GRANTED` / `DENIED`                                                                |
| Anlamı           | Hasta bilgilendirildi  | Hasta belirli işleme özgür iradeyle izin verdi / vermedi                            |

Aydınlatma kaydı **asla** "rıza verildi" olarak kaydedilmez. Kural üç katmanda uygulanır: şablon şeması
(`KVKK_DISCLOSURE` şablonu `CONSENT` seçimi içeremez), servis (`validateChoices()`), veritabanı
(`consent_choices_guard`). Ayrı bir `REJECTED` değeri yoktur; reddetmek `DENIED`'dir.

Standart açık rıza anahtarları (seed): `MARKETING_SMS`, `MARKETING_EMAIL`, `MARKETING_PHONE`, `MARKETING_WHATSAPP`.
Her kanal ayrıdır, hiçbiri önceden işaretli değildir ve rıza vermemek hizmeti engellemez.

## Veri modeli

```
document_templates  (tenant_id?, type, name, version, content, choices[], active, published_at)
   │  Yayımlandıktan sonra content/choices/type/version/name DEĞİŞMEZ → yeni metin = yeni sürüm
   ▼
patient_documents   (… status, signer_type, guardian_relationship,
                     content_snapshot_encrypted, content_sha256,
                     signature_storage_key, pdf_storage_key, document_sha256,
                     voided_at, voided_by_user_id, void_reason)
   │  DRAFT → PRESENTED → SIGNED ;  SIGNED → VOIDED (gerekçe + kim + ne zaman)
   ▼
consent_choices     (tenant_id, patient_document_id, key, value, decided_at)   — imzalı belgede değişmez
   ▼
consent_revocations (tenant_id, patient_id, consent_choice_id UNIQUE, channel, reason, revoked_by_user_id, revoked_at)
                     yalnızca ekleme; yalnızca SIGNED belgedeki GRANTED seçim geri çekilebilir
```

### Snapshot ve TOCTOU koruması

Belge DRAFT olarak oluşturulduğu anda güncel şablonun **tam içeriği** (başlık, ad, sürüm, metin, seçim tanımları)
AES-256-GCM ile şifrelenip `content_snapshot_encrypted` alanına yazılır; kanonik özeti `content_sha256`'dır.
Önizleme her zaman bu snapshot'tan yapılır (şablondan değil). İmza isteği önizlenen `contentSha256`'yı geri gönderir;
eşleşmezse `CONFLICT`. Böylece önizleme ile imza arasında şablon yeni sürüme geçse bile hasta, gördüğü metni imzalar.
Tetikleyici: snapshot bir kez yazıldıktan sonra değiştirilemez.

### Durum makinesi (DB tetikleyicisi `patient_documents_guard` + servis)

- INSERT: yayımlanmış şablon sürümü ve snapshot zorunlu.
- `PRESENTED → DRAFT` yasak; kimlik sütunları (hasta, şube, şablon, sürüm) değişmez.
- `SIGNED` için zorunlu: `signed_at`, imzalayan adı, `signer_type`, imza ve PDF anahtarları, PDF SHA-256, snapshot.
- `SIGNED → VOIDED` dışında geçiş yok; VOID kanıt alanlarına dokunamaz ve `voided_at/by/reason` zorunludur.
- `VOIDED` tamamen değişmez. SIGNED/VOIDED silinemez (yalnızca yasal imha bağlamı).
- Eşzamanlı imza: `SELECT … FOR UPDATE` → ikinci istek `DOCUMENT_ALREADY_SIGNED` alır (testte 1 başarılı / 1 red).

## Klinik akışı (`/patients/new` sihirbazı)

1. **Hasta bilgileri** — kayıt + deterministik mükerrer uyarısı (normalize telefon / e-posta / ad+soyad+doğum
   tarihi; yalnızca kiracı + şube kapsamında; birleştirme YOK).
2. **KVKK** — aydınlatma snapshot'ı gösterilir; "okudum, bilgilendirildim" onayı.
3. **Açık rıza** — her kanal için ayrı Onaylıyorum / Onaylamıyorum.
4. **İmza** — imzalayan: hasta veya veli / yasal temsilci (+ yakınlık zorunlu; yaş kuralı kodlanmaz). İmza alanının
   üstünde: "Bu imza, yukarıda görüntülenen belgenin bu sürümüne aittir." Tek imza her iki belgeye uygulanır.
5. **Tamamlandı** — hasta no ve hasta dosyası bağlantısı.

Sonradan yeni belge: hasta dosyası → Belgeler → "İmzaya hazırla" → `/patients/[id]/documents/sign` (kenar menüsüz
tablet odak ekranı, 768px'te kullanılabilir).

## KVKK durumu (türetilmiş, saklanmaz)

| Durum      | Koşul                                                                                  |
| ---------- | -------------------------------------------------------------------------------------- |
| `COMPLETE` | İmzalı aydınlatma VE (yayımlanmış açık rıza şablonu yoksa veya rıza kararı verilmişse) |
| `PARTIAL`  | Yukarıdakilerden biri var ya da bekleyen (DRAFT/PRESENTED) belge var                   |
| `MISSING`  | Hiçbiri yok                                                                            |

`DENIED` geçerli bir karardır; durumu eksik yapmaz.

## Rıza durumu ve geri çekme

`getCurrentConsentState(patient, key)` → `GRANTED` · `DENIED` · `REVOKED` · `NOT_ASKED`. En güncel imzalı karar
geçerlidir; sorulmamış rıza **asla** `GRANTED` sayılmaz. Geri çekme yeni bir `consent_revocations` satırıdır —
orijinal imzalı belge, PDF ve seçim değişmez. Aydınlatma onayı geri çekilemez (tetikleyici).

## Final PDF (v2)

A4; her sayfada header (1. sayfa: klinik logosu, klinik adı, ticari unvan, şube + adres, telefon, web; sonraki
sayfalar kompakt) ve footer (`Belge ID · vN · SHA-256: <16 hane>…`, `Sayfa X / Y`, "Kliniva AI ile oluşturuldu").
Gövde: belge başlığı, hasta bilgi kartı (ad, hasta no, şube, tarih), metin, onay tablosu (Onaylı / Reddedildi),
imza bloğu (Hasta / Yasal temsilci, yakınlık, tarih-saat, statik imza). Otomatik sayfalama; tablo satırları ve imza
bloğu sayfa arasında bölünmez; tablo başlığı yeni sayfada tekrarlanır. Türkçe karakterler (Inter, SIL OFL).
Logo yoksa sade metin başlık — Kliniva logosu klinik logosu yerine **kullanılmaz**. Testler pdfjs ile metni ve
yerleşim kutularını doğrular (`tests/unit/pdf-layout.test.ts`).

İki özet: PDF içinde snapshot içerik özeti; veritabanında `document_sha256` = PDF baytlarının SHA-256'sı.

## Bütünlük

`verifyPatientDocumentIntegrity()` ve her PDF okuması: snapshot özeti ve PDF SHA-256'sı doğrulanır. Uyuşmazlık,
eksik PDF ya da şifreli nesnenin kimlik doğrulamasının (GCM) başarısız olması → `DOCUMENT_INTEGRITY_FAILED` (422) ve
ayrı transaction'da `PATIENT_DOCUMENT_INTEGRITY_FAILED` audit kaydı; belge sunulmaz.

## Dosya uç noktası

`GET /api/v1/patients/{id}/documents/{docId}/file[?kind=signature][&download=1]` — oturum → kiracı (RLS) →
`patient.document.read` → belge bu hastaya ait → şube kapsamı → anahtar kiracıya ait → bütünlük. Başka kiracı /
hasta / şube: **404**. Yanıt: `Content-Type: application/pdf`, `Cache-Control: private, no-store`,
`X-Content-Type-Options: nosniff`, dosya adı `kvkk-belgesi-<belgeId>.pdf` (PII yok). Depolama anahtarı hiçbir
yanıtta yer almaz.

## Özel depo

Arayüz: `put / get / exists / deleteIfAllowed`. Anahtar: `tenant/<kiracı>/<documents|signatures|logos>/<uuid>.bin`
(hasta adı yok). Gövde uygulama düzeyinde AES-256-GCM ile şifreli (AAD = anahtar). Üzerine yazma yok (`wx` /
`If-None-Match: *`). Silme: logo serbest, belge ve imza yalnızca yasal imha bağlamında.

| Sürücü (`PRIVATE_STORAGE_DRIVER`) | Sınıf                        | Not                                                                                                                  |
| --------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `local` (varsayılan)              | `LocalEncryptedStorage`      | Geliştirme; üretimde uyarı log'u                                                                                     |
| `s3`                              | `S3CompatiblePrivateStorage` | S3 / R2 / MinIO, path-style, SigV4 (AWS test vektörüyle doğrulanır), ACL başlığı yok; yapılandırma yalnızca ortamdan |

## Hasta imzası — biyometrik veri YOK

İmza alanı yalnızca canvas'a sabit kalınlıkta çizer; nokta geçmişi tutulmaz, `pressure`/`tilt`/`timeStamp`
okunmaz. Çıktı yalnızca `toDataURL("image/png")`. Sunucu: yalnızca `data:image/png` kabul eder, en fazla 300 KB,
PNG imzası + sharp ile gerçek PNG doğrulaması, boyut 50–2400 × 20–1200, **yeniden kodlama** (tüm meta veri atılır).

## RBAC

| Yetki                      | Kimde                                                 |
| -------------------------- | ----------------------------------------------------- |
| `patient.document.read`    | Yönetim, şube müdürü, resepsiyon, doktor, asistan     |
| `patient.document.create`  | Yönetim, şube müdürü, resepsiyon                      |
| `patient.document.present` | Yönetim, şube müdürü, resepsiyon                      |
| `patient.document.sign`    | Yönetim, şube müdürü, resepsiyon                      |
| `patient.document.void`    | Yalnızca yönetim rolleri (klinik sahibi / yöneticisi) |

## Saklama ve imha

İmzalı belgeler, rıza geri çekmeleri ve audit log silinemez; tek istisna yasal saklama süresi dolduğunda transaction
içinde `set_config('kliniva.retention_purge', 'on', true)` ile yapılan denetimli imhadır. Entegrasyon ve E2E
testleri yalnızca kendi oluşturdukları kayıtları bu yolla temizler.

## İlgili hak talepleri (KVKK m.11)

Rıza geri çekme bu sprintte hazır. Bilgi talebi dışa aktarımı ve düzeltme talebi akışı sonraki sprintlerdedir.
