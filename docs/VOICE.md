# Kliniva AI — Sesli asistan (Sprint 7)

Klinik operasyonları için Türkçe (isteğe bağlı İngilizce) canlı sesli asistan. Tıbbi karar vermez; tanı / tedavi /
ilaç / reçete önerisi yoktur ("Bu konuda klinik kararı yetkili hekimin vermesi gerekir.").

## Mimari

```
Tarayıcı (voice-assistant.tsx)                     Sunucu (Next.js)                         OpenAI
 ─ mikrofon izni YALNIZCA "Başlat" tıklamasında
 ─ POST /api/v1/voice/session  ───────────────▶  requireUser + voice.use + voiceEnabled
                                                 hız sınırı + kullanıcı başına 2 etkin oturum
                                                 talimat + araç şemaları (kiracı verisi YOK)
                                                 POST /v1/realtime/client_secrets  ───────────▶  kısa ömürlü sır (120 sn)
 ◀── { sessionId, clientSecret, model, ... } ───
 ─ RTCPeerConnection + "oai-events" kanalı
 ─ POST /v1/realtime/calls (SDP, Bearer <kısa ömürlü sır>)  ─────────────────────────────────▶  ses ↔ model
 ─ response.function_call_arguments.done
 ─ POST /api/v1/voice/tools {sessionId, name, arguments, utterance}
                                                 loadVoiceToolContext: aynı kullanıcı + ACTIVE + süresi dolmamış
                                                 Zod doğrulama → MEVCUT iş servisi (RBAC / RLS / kapsam)
 ◀── araç sonucu (minimum veri) ───────────────
 ─ conversation.item.create (function_call_output) + response.create
```

- `OPENAI_API_KEY` yalnızca sunucuda okunur (`src/server/voice/transport.ts`); kaynakta, istemci paketinde, log'da,
  yanıtta, audit'te yoktur (bundle testi `OPENAI_API_KEY`, `sk-` deseni, `realtime/client_secrets` arar).
- Kiracı / kullanıcı / rol / şube / doktor kimliği **her zaman sunucu oturumundan** gelir. Araç şemalarında
  `tenantId` / `userId` yoktur; model ek alan gönderirse Zod siler.
- AI doğrudan DB'ye erişmez; yeni SQL yazmaz; yalnızca mevcut servisleri `ctx.channel = "AI_VOICE"` ile çağırır.
- Ham ses ve tam döküm **saklanmaz**. Panel kapatılınca ekrandaki döküm de silinir.

## Araçlar (19)

| Tür   | Araç                                                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Okuma | `voice_resolve_date`, `voice_list_branches`, `voice_list_services`, `voice_list_doctors`, `voice_get_doctor_availability`, `voice_get_today_appointments`, `voice_get_branch_summary`, `voice_get_appointment`, `voice_find_patient`, `voice_get_inventory`, `voice_get_low_stock`, `voice_get_expiring_lots` |
| Yazma | `voice_create_appointment`, `voice_reschedule_appointment`, `voice_cancel_appointment` (gerekçe zorunlu olabilir), `voice_confirm_appointment`, `voice_create_material_usage_draft` (yalnızca TASLAK)                                                                                                         |
| Onay  | `voice_confirm_action`, `voice_cancel_action`                                                                                                                                                                                                                                                                 |

**Sesle yapılamaz:** kullanıcı / rol / yetki, KVKK rızası, imza, belge VOID, lot geri çağırma, imha, şifre / MFA,
audit, hasta silme, tanı / tedavi / reçete, malzeme kullanımını kesinleştirme. Bu istekler araç çağrılmadan
reddedilir ("Bu işlem sesli asistan üzerinden gerçekleştirilemiyor…").

Tarihler sunucuda klinik saat dilimiyle çözülür (`bugün`, `yarın`, `cuma`, `gelecek pazartesi`, `16 Ekim`,
`20.10.2026`); model tarih hesaplamaz. Hasta arama en fazla 5 sonuç ve maskeli telefon döndürür; aynı ad birden fazla
kayıtta → asistan hasta numarasını sorar, kendisi seçmez.

## Onaylı yazma (PendingAIAction)

1. **Hazırla:** girdi doğrulanır / çözülür → kanonik JSON → AES-GCM şifreli (`ai_action.input:<tenant>:<id>` AAD) +
   SHA-256 bütünlük özeti. İdempotency anahtarı `H(oturum | araç | girdi)`; etkin durumlar için kısmi benzersiz indeks.
   Asistan özeti okur: _"Ayşe Y. (KLI-…) için Merkez şubesinde Dr. Ahmet Kaya ile 16 Ekim 2026 Cuma, 14:30 saatine 30
   dakikalık Muayene randevusu oluşturacağım. Onaylıyor musunuz?"_
2. **Onay:** yalnızca aynı kullanıcı + aynı ses oturumu + süresi dolmamış (DB saati, varsayılan 120 sn) eylem. Sesli
   onayda kullanıcının son sözü açık onay olmalı (`evet`, `onaylıyorum`, `tamam`); `olabilir`, `bakalım`, `sanırım`
   onay **değildir**. Ekrandaki "Onayla" düğmesi de aynı uç nokta kurallarına tabidir.
3. **Yürüt:** `PENDING → CONFIRMED` tek UPDATE ile talep edilir (eşzamanlı onaylardan yalnızca biri yürütür) → iş
   servisi → `EXECUTED` / `FAILED`. Tekrar onay veya yinelenen araç çağrısı `ALREADY_EXECUTED` döndürür; ikinci randevu,
   bildirim, taşıma veya iptal oluşmaz.
4. Hazırlıkla onay arasında slot dolarsa: _"Bu saat artık müsait değil."_ (çift kayıt yok). `DOCTOR_APPROVAL`
   modunda: _"Randevu oluşturuldu ve doktor onayına gönderildi."_

DB koruması: girdi / özet / anahtar / kimlik / süre değişmez; son durumlar değişmez; uygulama rolü silemez
(tetikleyici + sütun yetkileri). Ayrıntı: `docs/DATABASE.md`.

## Gizlilik

- `voicePrivacyMode` (Klinik ayarları): **DISCREET** (varsayılan) → hasta adı "Ayşe Y."; **STANDARD** → tam ad. Telefon
  her zaman maskeli (son 2 hane); TC kimlik, sağlık notu, doğum tarihi araç çıktısına hiç girmez.
- `ai_action_logs` ve metrikler: araç adı, süre, sonuç kodu, kimlikler — hasta adı / telefon / döküm / ses yok.
- Talimatlar (system prompt) yalnızca davranış kurallarını içerir; kiracı verisi içermez.

## Yapılandırma

| Değişken                    | Varsayılan               | Not                                                            |
| --------------------------- | ------------------------ | -------------------------------------------------------------- |
| `OPENAI_API_KEY`            | —                        | Yoksa sesli asistan "kullanılamıyor" (503) döner               |
| `OPENAI_REALTIME_MODEL`     | `gpt-realtime`           |                                                                |
| `OPENAI_TRANSCRIBE_MODEL`   | `gpt-4o-mini-transcribe` |                                                                |
| `OPENAI_REALTIME_VOICE`     | `marin`                  |                                                                |
| `VOICE_CONFIRM_TTL_SECONDS` | `120`                    | 1–600                                                          |
| `VOICE_TRANSPORT=mock`      | tanımsız                 | YALNIZCA test / E2E: ağ çağrısı yok, metin komut kutusu açılır |

Klinik ayarları: `voiceEnabled`, `voicePrivacyMode`, `preferredVoiceLanguage` (tr / en). Yetki: `voice.use` (tüm
operasyon rolleri; READ_ONLY ve platform yöneticisi hariç). Oturum hız sınırı: kullanıcı başına 10 dakikada 20; aynı
anda en fazla 2 etkin oturum (`VOICE_SESSION_LIMIT`).

CSP: `connect-src 'self' https://api.openai.com`; `unsafe-eval` / `unsafe-inline` yok. `Permissions-Policy:
microphone=(self)`.

## Test

- `tests/unit/voice.test.ts` — tarih çözümü, onay ayrıştırma, gizlilik, hata çevirisi, sınırlar, grounding, şema.
- `tests/integration/sprint7.test.ts` — sahte taşıyıcı ile oturum güvenliği, kapsam, onay / idempotency / eşzamanlılık,
  izolasyon, TTL, kurcalama, çakışma, DOCTOR_APPROVAL, taşıma / iptal, taslak, metin düzeneği (`simulateVoiceTurn`),
  RLS + havuz yükü.
- `tests/e2e/sprint7.spec.ts` — panel (sahte taşıyıcı, metin komutu): doktor bugünkü randevular, resepsiyon randevu +
  "Evet" ×2, çakışma, ölçülü gizlilik, bildirim, CSP / konsol / taşma.
- `npm run test:voice` — isteğe bağlı GERÇEK OpenAI duman testi (istemci sırrı üretimi); anahtar yoksa atlanır.

Gerçek WebRTC ses akışı (mikrofon, barge-in, gürültü) yalnızca geçerli bir `OPENAI_API_KEY` ile tarayıcıda elle
doğrulanabilir.
