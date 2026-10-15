# Stok ve Hasta Malzeme Kullanımı — Kliniva AI (Sprint 4–5)

## Model

| Tablo                                | Amaç                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `inventory_categories`               | Stok kategorisi (Enjektörler, Punchlar …)                                                     |
| `inventory_items`                    | Ürün: ad, kod, barkod, birim (`inventory_unit`), asgari stok, stok takibi, lot/SKT bayrakları |
| `inventory_locations`                | `BRANCH_WAREHOUSE` (şube deposu) veya `ROOM` (oda başına tek, oda aynı şubede — bileşik FK)   |
| `stock_movements`                    | **Defter — kaynak gerçek.** Yalnızca eklenir                                                  |
| `stock_balances`                     | Bakiye önbelleği (ürün × lokasyon), `quantity >= 0`; yalnızca defter tetikleyicisi yazar      |
| `patient_material_usages`            | Hasta / randevu bazlı kullanım: `DRAFT → FINALIZED → VOIDED`, şifreli not                     |
| `patient_material_usage_items`       | Kullanım kalemleri (ürün, lokasyon, miktar) — yalnızca DRAFT iken değişir                     |
| `service_material_templates`         | Hizmet → önerilen malzemeler (**yalnızca öneri, stok düşürmez**)                              |
| `stock_lots`                         | Lot satırı (ürün × lokasyon × lot no): SKT, miktar önbelleği, geri çağırma (Sprint 5)         |
| `patient_material_usage_allocations` | Kullanım kalemi → lot tahsisi (bir kalem birden çok lot; Sprint 5)                            |

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

## Lot / parti, SKT ve FEFO (Sprint 5)

### Takip bayrakları

- `track_lots` — her stok girişi lot numarası ister. `track_expiry` — SKT zorunlu; **lot takibi gerektirir**
  (Zod + DB CHECK `inventory_items_expiry_requires_lots_ck`).
- Mevcut ürünler `track_lots = false` kalır; uydurma lot oluşturulmaz, mevcut defter değişmez.
- Lot takibini AÇMAK: üründe fiziksel stok varsa `TRACKING_MODE_CHANGE_REQUIRES_MIGRATION` (önce sayım / düşüm).
- Lot takibini KAPATMAK: lot geçmişi varsa `LOT_TRACKING_ALREADY_IN_USE`.
- SKT takibini açmak: SKT'siz lot varsa `TRACKING_MODE_CHANGE_REQUIRES_MIGRATION`.
- Mod değişikliği ürün satırını `FOR UPDATE`, stok hareketleri `FOR SHARE` kilitler → hareket sürerken mod değişmez.
  DB tetikleyicisi de lot takipli üründe lotsuz / lotsuz üründe lotlu hareketi reddeder.

### Lot satırı ve kimlik

`stock_lots` satırı = (ürün, lokasyon, lot no) — benzersiz (`stock_lots_identity_uq`). **Lot kimliği = ürün + lot
numarası**: transfer hedefte aynı numara + aynı SKT ile ayrı bir satır açar (tetikleyici eşitliği doğrular). Lot
numarası değişmez (sütun UPDATE yetkisi yok + tetikleyici). `quantity` yalnızca defter tetikleyicisinin güncellediği
önbellektir (uygulama rolünde sütun UPDATE yetkisi yok); kaynak gerçek her zaman `stock_movements`
(`from_stock_lot_id` / `to_stock_lot_id`, bileşik FK: lot AYNI ürün + AYNI lokasyon). Yeni lot satırı miktar 0 ile
açılır; stok yalnızca hareketle gelir. Lot satırları silinmez.

### SKT anlamı (saat dilimi)

`expiry_date` bir `DATE`'tir. Lot, **bulunduğu şubenin yerel takviminde SKT gününün sonuna kadar** kullanılabilir:
`bugün(şube saat dilimi) <= SKT` → geçerli, `bugün > SKT` → süresi geçmiş. "Bugün" her zaman sunucuda hesaplanır
(`dateInZone(now, branch.timezone)` ve DB'de `kliniva.lot_expired()`); istemci tarihine güvenilmez. Yaz saati geçişleri
(ör. Europe/Berlin 29.03 / 25.10) yerel gece yarısını değiştirmez — birim testleri bu sınırları doğrular.

### FEFO (`selectFefoLots`, `src/server/inventory/fefo.ts`)

Yalnızca **kullanılabilir** lotlar (aktif, geri çağrılmamış, miktar > 0, SKT'si geçmemiş) şu sırayla:
en yakın SKT → SKT'siz lotlar en sona → teslim alma zamanı (eski önce) → id. Birden fazla lot kullanılabilir; toplam
yetmezse **kısmi tahsis yapılmaz** (`INSUFFICIENT_STOCK`).

### Hasta kullanımı ve tahsis

- DRAFT stok düşürmez. Ekranda FEFO önerisi gösterilir; kullanıcı lotu elle seçebilir
  (`patient_material_usage_allocations`, toplam = kalem miktarı). Kalemin miktarı değişince elle seçim temizlenir.
- Elle seçimde süresi geçmiş (`LOT_EXPIRED`), geri çağrılmış (`LOT_RECALLED`), yetersiz (`INSUFFICIENT_STOCK`) veya
  kapsam dışı / başka lokasyonun lotu (`NOT_FOUND`) seçilemez.
- **Kesinleştirme** tüm kalemleri kilitler; elle seçimi kilit altında güncel veriyle yeniden doğrular, yoksa FEFO
  çalıştırır; tahsisleri + her tahsis için `PATIENT_USAGE` hareketini (kaynak lot) TEK transaction'da yazar. Bir kalem
  bile başarısızsa hiçbir stok düşmez. Kesinleşmiş tahsisler değişmez (tetikleyici).
- **VOID** her kullanım hareketini aynı lota (`to_stock_lot_id`) `RETURN_FROM_PATIENT_USAGE` ile iade eder.
- Hasta "Malzemeler" ve kullanım detayı kullanılan lot numaralarını gösterir (`inventory.lot.read`).

### Fiziksel vs kullanılabilir stok

Fiziksel = raftaki (defter). Kullanılabilir = lot takipli üründe SKT'si geçmiş / geri çağrılmış / pasif lotlar hariç.
Kritik stok ve "tükenen" listeleri **kullanılabilir** stoğa göre hesaplanır.

### Geri çağırma (recall)

`recallLot` (`inventory.lot.recall`, varsayılan yalnızca klinik sahibi / yöneticisi; ayrıca **kiracı geneli kapsam** zorunlu — şube kapsamlı kullanıcı izin verilse bile `FORBIDDEN`): gerekçe zorunlu (AES-256-GCM, audit'e yazılmaz), **geri alınamaz**
(tetikleyici). Lot kimliğinin TÜM lokasyonlardaki satırları işaretlenir. Sonrasında yeni hasta kullanımı, transfer ve
aynı numarayla yeni giriş (mevcut satıra dahil) `LOT_RECALLED`; geçmiş kullanımlar değişmez. Kilit sırası: lot kimliği kilidi → stok
kilitleri (giriş / transfer de aynı sırayı izler) → kesinleştirme ile serileşir, kilitlenme olmaz.

### İmha, sayım, SKT düzeltme

- `writeOffLot` (`inventory.write_off`): SKT'si geçmiş veya geri çağrılmış lot → `WRITE_OFF` hareketi, gerekçe zorunlu.
- `recordPhysicalCount` (`inventory.physical_count`): beklenen vs sayılan; onay olmadan kayıt yok, onayla fark kadar
  `ADJUSTMENT_IN/OUT` (lot takipli üründe lot bazında).
- `correctLotMetadata` (`inventory.lot.correct_metadata`, yalnızca sahip / yönetici): SKT düzeltmesi, kimliğin tüm
  satırlarına; önceki / yeni SKT `LOT_METADATA_CORRECTED` audit'inde.

### Hasta izleme (`findPatientsByLot`)

`inventory.lot.trace` (sahip / yönetici). Lot kimliğinin tüm satırları üzerinden kesinleşmiş / VOID kullanımlar;
yalnızca hasta kimliği + dosya numarası (ad / iletişim yok); kullanım şubesi ve hasta görünürlüğü kapsamı uygulanır.
Her görüntüleme `LOT_PATIENT_TRACE_VIEWED` (lot + sonuç sayısı; hasta kimliği yok).

### Ekranlar

`/inventory` lot kartları (yaklaşan / geçmiş / lot takipli ürün), `/inventory/expiry` (Yakında dolacak / Süresi geçmiş;
şube, lokasyon, kategori, gün filtresi; varsayılan pencere `clinic_profiles.expiry_warning_days` = 30),
`/inventory/items/[id]` Lotlar bölümü + hareket lot filtresi + sayım, `/inventory/lots/[id]` (SKT düzelt, imha, geri
çağır, hasta izleme), kullanım ekranında FEFO önerisi + elle lot seçimi.

### Yetki (Sprint 5)

| İzin                                                                                               | Kimde                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `inventory.lot.read`                                                                               | sahip, yönetici, şube müdürü, stok sorumlusu, doktor, asistan, resepsiyon |
| `inventory.lot.manage`, `inventory.expiry.read`, `inventory.write_off`, `inventory.physical_count` | sahip, yönetici, şube müdürü, stok sorumlusu                              |
| `inventory.lot.recall`                                                                             | sahip, yönetici (kiracı geneli)                                           |
| `inventory.lot.correct_metadata`, `inventory.lot.trace`                                            | sahip, yönetici                                                           |
