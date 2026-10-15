# Stok ve Hasta Malzeme Kullanımı — Kliniva AI (Sprint 4)

## Model

| Tablo                          | Amaç                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `inventory_categories`         | Stok kategorisi (Enjektörler, Punchlar …)                                                     |
| `inventory_items`              | Ürün: ad, kod, barkod, birim (`inventory_unit`), asgari stok, stok takibi, lot/SKT bayrakları |
| `inventory_locations`          | `BRANCH_WAREHOUSE` (şube deposu) veya `ROOM` (oda başına tek, oda aynı şubede — bileşik FK)   |
| `stock_movements`              | **Defter — kaynak gerçek.** Yalnızca eklenir                                                  |
| `stock_balances`               | Bakiye önbelleği (ürün × lokasyon), `quantity >= 0`; yalnızca defter tetikleyicisi yazar      |
| `patient_material_usages`      | Hasta / randevu bazlı kullanım: `DRAFT → FINALIZED → VOIDED`, şifreli not                     |
| `patient_material_usage_items` | Kullanım kalemleri (ürün, lokasyon, miktar) — yalnızca DRAFT iken değişir                     |
| `service_material_templates`   | Hizmet → önerilen malzemeler (**yalnızca öneri, stok düşürmez**)                              |
| `stock_lots`                   | Lot / son kullanma temeli (lot bazlı tüketim Sprint 5)                                        |

Miktarlar `numeric(14,3)` — float yok; uygulamada binde birim tamsayı aritmetiği (`src/lib/quantity.ts`). Birim
dönüşümü yoktur: tüm hareketler ürünün birimiyle yürür.

## Defter ve bakiye

```
stock_movements (INSERT)  ──tetikleyici (SECURITY DEFINER)──▶  stock_balances
  from_location: UPDATE … SET quantity = quantity − q WHERE quantity >= q   (bulunamazsa KLINIVA_INSUFFICIENT_STOCK)
  to_location:   INSERT … ON CONFLICT DO UPDATE quantity = quantity + q
```

- Hareket tipleri ve şekil (CHECK): `INITIAL_STOCK / PURCHASE / ADJUSTMENT_IN / RETURN_FROM_PATIENT_USAGE` →
  yalnızca hedef; `ADJUSTMENT_OUT / WRITE_OFF / PATIENT_USAGE` → yalnızca kaynak; `TRANSFER` → ikisi, farklı.
  Kullanım hareketleri `patient_usage_id` taşır.
- **Değişmezlik:** uygulama rolünün `stock_movements` üzerinde UPDATE/DELETE yetkisi yoktur; tetikleyici sahip rolü
  bile engeller (yalnızca yasal imha bağlamında silme). Hata → ters hareket (ör. `ADJUSTMENT_IN +5`).
- **Bakiye yazımı:** uygulama rolü `stock_balances`'ı yalnızca OKUR. Defter ile bakiye uygulama hatasıyla ayrışamaz.
- **Negatif stok yok:** servis kontrolü + tetikleyicinin koşullu UPDATE'i + `CHECK (quantity >= 0)`.
  `clinic_profiles.allow_negative_stock` sütunu vardır ve bu sürümde `CHECK (= false)`.

## İşlem güvenliği

Her stok değişimi tek transaction'dır: advisory lock (ürün + lokasyon, deterministik sıra) → mevcut miktar kontrolü →
hareket INSERT (tetikleyici bakiyeyi atomik günceller) → audit. Testlerle kanıtlanır:

- 1 adet stok, 20 eşzamanlı kesinleştirme → tam 1 başarılı, 19 `INSUFFICIENT_STOCK`, bakiye 0.
- 10 adet, 20 eşzamanlı 1'er transfer → 10 başarılı, toplam korunur, negatif yok.
- Çok kalemli kullanımda tek kalem yetersizse hiçbir stok düşmez, kısmi hareket oluşmaz.

**Transfer** tek `TRANSFER` hareketidir; iki bakiye aynı transaction'da güncellenir. Şubeler arası transfer ayrıca
`inventory.transfer.cross_branch` ister (şube müdürüne verilmez).

**İlk stok** ayrı işlemdir ve bir ürün × lokasyon için yalnızca hiç hareket yokken kullanılabilir; sonrası alım
(`PURCHASE`) veya düzeltmedir. Yeni ürün stoksuz oluşturulur.

## Hasta malzeme kullanımı

1. **Taslak** — randevudan (`IN_PROGRESS` veya `COMPLETED`; iptal / gelmedi reddedilir) veya hasta + şubeden
   oluşturulur. Randevunun hizmetinin şablonu taslağa **öneri** olarak eklenir; stok kaynağı olarak randevu odasının
   lokasyonu, yoksa şube deposu önerilir. Taslak stok düşürmez; kalemler ve miktarlar düzenlenir.
2. **Kesinleştir** — tüm kalemler kilitlenir, hepsi kontrol edilir, ancak sonra `PATIENT_USAGE` hareketleri eklenir;
   kullanım `FINALIZED` olur. Sonrasında kullanım ve kalemleri değişmez (DB tetikleyicisi).
3. **VOID** — gerekçe zorunlu; orijinal hareketler silinmez, her biri için `RETURN_FROM_PATIENT_USAGE` eklenir; stok
   aynı lokasyona döner; kullanım `VOIDED`. İkinci VOID reddedilir. Yalnızca yüksek yetkili roller.

DB güvenceleri: kullanımın randevusu aynı kiracı + **aynı hasta + aynı şube** olmak zorunda (bileşik FK); kalem
lokasyonu kullanımın şubesinde olmak zorunda (tetikleyici).

**Doktor kapsamı:** yalnızca kendi randevularına bağlı kullanım oluşturur / görür / kesinleştirir; başka doktorun
randevusu `NOT_FOUND`; randevusuz kullanım oluşturamaz. Asistan kendi şube kapsamında çalışır.

## Kritik stok ve panel

`getLowStockItems()`: ürün düzeyindeki asgari seviye ile **lokasyon** bakiyesi karşılaştırılır
(`quantity <= minimumStockLevel`) + görünür lokasyonlarda toplamı 0 olan ürünler. `/inventory` kartları: aktif ürün,
düşük stok, tükenen, bugünkü tüketim, bugünkü transfer (şube / lokasyon / kategori filtresi).

## Uzlaştırma

- `verifyStockBalance()` — defter toplamı ile bakiyeyi karşılaştırır; fark varsa `STOCK_BALANCE_MISMATCH` audit.
- `reconcileStockBalance()` — önce kuru çalıştırma (beklenen / gerçek / fark). Uygulandığında bakiye **önbelleği**
  defterden yeniden hesaplanır (`kliniva.recompute_stock_balance`, yalnızca oturumdaki kiracı); defter değişmez,
  `STOCK_BALANCE_RECONCILED` audit'lenir. Fiziksel sayım farkı ise `adjustStock` (ADJUSTMENT hareketi) ile düzeltilir —
  önbellek farkı için hareket eklemek defteri yanlışlıkla ikiye katlardı.

## Yetki

| Yetki                                                                            | Rol                                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `inventory.read`                                                                 | Yönetim, şube müdürü, stok sorumlusu, doktor, asistan, resepsiyon, salt okunur |
| `inventory.item.create/update`, `stock.add/adjust`, `transfer`, `low_stock.read` | Yönetim, şube müdürü (kendi şubesi), stok sorumlusu                            |
| `inventory.transfer.cross_branch`                                                | Klinik sahibi / yöneticisi, stok sorumlusu                                     |
| `inventory.usage.create/finalize/read`                                           | Yönetim, şube müdürü, doktor (yalnızca kendi randevusu), asistan (şube)        |
| `inventory.usage.void`, `inventory.reconcile`                                    | Yalnızca klinik sahibi / yöneticisi                                            |

Şube kapsamlı kullanıcı yalnızca kendi şubesinin lokasyonlarını görür; başka şubenin lokasyonu `NOT_FOUND`.

## Voice AI hazırlığı

`src/server/inventory/contracts.ts`: `RecordMaterialUsageInput` (taslak + kalemler + isteğe bağlı kesinleştirme —
`recordMaterialUsage()` tek transaction), `GetInventoryInput`, `TransferStockInput`, `AddStockInput`,
`AdjustStockInput`. Servisler HTTP / AI bağımsızdır; bu sprintte AI bağlantısı yoktur.

## Lot / son kullanma

`stock_lots` tablosu ve `track_lots / track_expiry` bayrakları hazırdır; `getExpiringLots()` rapor temelidir. Lot
takipli ürünlerin stok hareketleri bu sürümde reddedilir (Sprint 5: lot seçimi, süresi geçmiş lotun kullanılamaması,
FEFO).
