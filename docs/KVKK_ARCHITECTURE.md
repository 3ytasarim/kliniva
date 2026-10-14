# KVKK Belge Mimarisi — Kliniva AI

> Hukuki not: Bu belge teknik mimariyi açıklar. Aydınlatma ve rıza metinlerinin içeriği kliniğin (veri sorumlusu)
> hukuk danışmanınca onaylanmalıdır. Seed'deki metinler yalnızca şablondur.

## Aydınlatma ≠ Açık Rıza

|                  | Aydınlatma (KVKK m.10) | Açık rıza (KVKK m.3, m.6)                                |
| ---------------- | ---------------------- | -------------------------------------------------------- |
| Belge tipi       | `KVKK_DISCLOSURE`      | `EXPLICIT_CONSENT`                                       |
| Seçim türü       | `ACKNOWLEDGEMENT`      | `CONSENT`                                                |
| Kaydedilen değer | `READ_AND_INFORMED`    | `GRANTED` / `DENIED`                                     |
| Anlamı           | Hasta bilgilendirildi  | Hasta belirli işleme özgür iradeyle izin verdi / vermedi |

Aydınlatma kaydı **asla** "rıza verildi" olarak kaydedilmez. Bu kural üç yerde uygulanır:

1. Şablon şeması: `KVKK_DISCLOSURE` şablonu `CONSENT` seçimi içeremez.
2. Servis: `validateChoices()` — ACKNOWLEDGEMENT yalnızca `READ_AND_INFORMED` kabul eder.
3. Veritabanı: `consent_choices_guard` tetikleyicisi aydınlatma belgesinde `READ_AND_INFORMED` dışını reddeder.

Açık rıza seçimleri her işlem için ayrıdır (ör. SMS hatırlatma, pazarlama) ve rıza vermemek hizmeti engellemez.

## Veri modeli

```
document_templates  (tenant_id?, type, name, version, content, choices[], active, published_at)
   │  UNIQUE NULLS NOT DISTINCT (tenant_id, type, version)
   │  Yayımlandıktan sonra content/choices/type/version/name DEĞİŞMEZ (tetikleyici)
   ▼
patient_documents   (tenant_id, patient_id, branch_id, document_template_id, document_version, status,
                     generated_at, presented_at, signed_at, signed_by_name, guardian_name,
                     signature_storage_key, pdf_storage_key, document_sha256, created_by_user_id)
   │  status: GENERATED → PRESENTED → SIGNED   (VOIDED: Sprint 1+)
   │  SIGNED/VOIDED sonrası UPDATE/DELETE yasak (tetikleyici)
   │  INSERT'te document_version = şablonun yayımlanmış versiyonu olmalı (tetikleyici)
   ▼
consent_choices     (tenant_id, patient_document_id, key, value, decided_at)
                     İmzalı belgenin seçimleri değişmez (tetikleyici)
```

## Klinik akışı

1. Personel hastayı seçer (`patient.read`, şube kapsamı).
2. Güncel (yayımlanmış + aktif) şablon versiyonundan belge üretilir → `PATIENT_DOCUMENT_GENERATED`.
3. Belge tablette hastaya sunulur → `PRESENTED`.
4. Hasta metni okur, seçimlerini yapar, tablette imzalar.
5. Sunucu: imza PNG'sini temizler → final PDF'i üretir → PDF'in SHA-256'sını hesaplar.
6. İmza ve PDF özel depoya **şifreli**, üzerine yazılamaz şekilde kaydedilir.
7. Tek transaction: seçimler + `SIGNED` + `PATIENT_DOCUMENT_SIGNED` audit.
8. Sonradan değişiklik imkânsız; yeni metin → yeni şablon versiyonu → yeni belge.

## Final PDF içeriği

Klinik unvanı · şube · hasta adı · hasta dosya no · belge tipi · belge versiyonu · belge metni · seçimler ·
hasta / yasal temsilci adı · statik imza · imza tarih-saati (şube saat dilimi) · belge ID · içerik özeti (SHA-256).

İki özet: PDF içinde **içerik özeti** (kanonik kanıt paketi: metin, seçimler, adlar, imza görüntüsünün özeti,
zaman); veritabanında `document_sha256` = **PDF dosyasının** SHA-256'sı (dosya kendi özetini içeremez).
PDF deterministiktir: aynı kanıt aynı baytları üretir. Okumada `X-Integrity-Verified` başlığı özet eşleşmesini bildirir.

## Hasta imzası — biyometrik veri YOK

İmza alanı (`src/components/signature-pad.tsx`) yalnızca canvas'a sabit kalınlıkta çizer ve `toDataURL("image/png")`
üretir. **Toplanmaz:** kalem basıncı, hareket hızı, ivme, vuruş zamanlaması, kalem açısı, biyometrik özellik vektörü,
davranışsal profil. Sunucu gelen PNG'yi yeniden paketler ve yalnızca `IHDR/PLTE/tRNS/IDAT/IEND` parçalarını tutar
(meta veri parçaları atılır). İmzaya yalnızca `document.read` yetkili kullanıcı, sunucu üzerinden erişir.

## Versiyonlama

- Şablon her yayımda yeni satırdır; eski versiyon pasifleşir ama **silinmez** (imzalı belgeler ona bağlıdır).
- İmzalı belge `document_template_id` + `document_version` ile o anki metne kalıcı bağlıdır.

## Saklama ve imha

- İmzalı belgeler ve audit log silinemez; tek istisna yasal saklama süresi dolduğunda yapılan **imha işlemidir**:
  transaction içinde `set_config('kliniva.retention_purge', 'on', true)` ile yapılır. Bu yol yalnızca denetimli bakım
  betiğinde kullanılır (Sprint 1+: imha tutanağı + audit). Entegrasyon testleri test kiracılarını bu yolla temizler.
- Saklama süreleri (ör. sağlık kayıtları için mevzuattaki süreler) klinik politikasına göre yapılandırılacaktır.

## İlgili hak talepleri (KVKK m.11)

Sprint 1+: hasta bilgi talebi dışa aktarımı, rıza geri çekme (yeni `EXPLICIT_CONSENT` belgesi + `DENIED`; eski
imzalı belge korunur), düzeltme talebi akışı.
