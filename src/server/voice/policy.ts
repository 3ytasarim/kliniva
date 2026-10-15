import type { VoiceLanguage } from "@/server/voice/dates";

/**
 * Sesli asistan politika yardımcıları — SAF: onay ayrıştırma, gizlilik biçimlendirme, alan hatası çevirisi,
 * desteklenmeyen / tıbbi istek tespiti, yanıtın araç sonucuna dayanması (grounding) kontrolü.
 */

// ---------------------------------------------------------------- onay

export type ConfirmationVerdict = "CONFIRM" | "REJECT" | "AMBIGUOUS";

const norm = (s: string) =>
  s
    .toLocaleLowerCase("tr-TR")
    .replace(/[.,!?;:"'()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const AFFIRMATIVE = [
  "evet",
  "onaylıyorum",
  "onayliyorum",
  "onaylıyoruz",
  "onayla",
  "tamam",
  "kabul",
  "yes",
  "confirm",
  "confirmed",
  "okay",
  "ok",
];
// Belirsiz / olumsuz: ONAY SAYILMAZ (olabilir, bakalım, sanırım, belki …).
const HEDGE = [
  "olabilir",
  "bakalım",
  "bakalim",
  "sanırım",
  "sanirim",
  "belki",
  "galiba",
  "emin değilim",
  "emin degilim",
  "maybe",
  "perhaps",
  "not sure",
  "i guess",
  "i think",
];
const NEGATIVE = [
  "hayır",
  "hayir",
  "vazgeç",
  "vazgec",
  "iptal et",
  "istemiyorum",
  "dur",
  "no",
  "cancel",
  "don't",
  "dont",
  "stop",
];

const hasWord = (text: string, w: string) =>
  new RegExp(`(^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(text);

/**
 * Kullanıcının SON sözü açık bir onay mı? Belirsiz ifade veya olumsuz kelime içeriyorsa ONAY DEĞİLDİR.
 * Model kendi kendine onay veremez: onay, sunucuya iletilen kullanıcı sözüyle (veya ekrandaki açık düğmeyle) yapılır.
 */
export function parseConfirmation(utterance: string | null | undefined): ConfirmationVerdict {
  const text = norm(utterance ?? "");
  if (!text) return "AMBIGUOUS";
  if (HEDGE.some((w) => text.includes(w))) return "AMBIGUOUS";
  if (NEGATIVE.some((w) => hasWord(text, w))) return "REJECT";
  if (AFFIRMATIVE.some((w) => hasWord(text, w))) return "CONFIRM";
  return "AMBIGUOUS";
}

// ---------------------------------------------------------------- gizlilik

export type VoicePrivacyMode = "STANDARD" | "DISCREET";

/** DISCREET: "Ayşe Y." (soyadının ilk harfi); STANDARD: tam ad. TC kimlik / telefon / sağlık notu hiçbir modda yok. */
export function voicePatientName(firstName: string, lastName: string, mode: VoicePrivacyMode): string {
  if (mode === "STANDARD") return `${firstName} ${lastName}`.trim();
  const initial = lastName.trim().charAt(0);
  return initial ? `${firstName} ${initial.toLocaleUpperCase("tr-TR")}.` : firstName;
}

/** Telefon her zaman maskeli: yalnızca son 2 hane. */
export function voiceMaskedPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ••• •• ${digits.slice(-2)}` : null;
}

// ---------------------------------------------------------------- alan hataları → doğal dil

const ERRORS_TR: Record<string, string> = {
  APPOINTMENT_CONFLICT: "Bu saat artık müsait değil.",
  ROOM_APPOINTMENT_CONFLICT: "Bu saat için uygun oda kalmadı.",
  PATIENT_APPOINTMENT_CONFLICT: "Hastanın bu saatte başka bir randevusu var.",
  SLOT_NOT_AVAILABLE: "Bu saat artık müsait değil.",
  APPOINTMENT_IN_PAST: "Geçmiş bir saate randevu oluşturulamaz.",
  BOOKING_OUT_OF_RANGE: "Bu tarih randevu alınabilecek aralığın dışında.",
  INSUFFICIENT_STOCK: "Yeterli kullanılabilir stok bulunmuyor.",
  LOT_EXPIRED: "Seçilen lotun son kullanma tarihi geçmiş.",
  LOT_RECALLED: "Seçilen lot geri çağrılmış.",
  NOT_FOUND: "Bu kaydı göremiyorum veya erişim yetkiniz yok.",
  FORBIDDEN: "Bu işlem için yetkiniz yok.",
  INVALID_STATUS_TRANSITION: "Randevunun mevcut durumu bu işleme uygun değil.",
  VALIDATION: "Bilgiler eksik veya geçersiz.",
  CONFIRMATION_EXPIRED: "Onay süresi doldu; işlemi yeniden özetlemem gerekiyor.",
  CONFIRMATION_REQUIRED: "Devam etmek için açık onayınız gerekiyor.",
  UNSUPPORTED: "Bu işlem sesli asistan üzerinden gerçekleştirilemiyor.",
  TOOL_FAILED: "Şu anda bunu sistemden doğrulayamıyorum.",
};
const ERRORS_EN: Record<string, string> = {
  APPOINTMENT_CONFLICT: "That time is no longer available.",
  ROOM_APPOINTMENT_CONFLICT: "No room is available at that time.",
  PATIENT_APPOINTMENT_CONFLICT: "The patient already has another appointment at that time.",
  SLOT_NOT_AVAILABLE: "That time is no longer available.",
  APPOINTMENT_IN_PAST: "Appointments cannot be booked in the past.",
  BOOKING_OUT_OF_RANGE: "That date is outside the bookable range.",
  INSUFFICIENT_STOCK: "There is not enough usable stock.",
  LOT_EXPIRED: "The selected lot has expired.",
  LOT_RECALLED: "The selected lot has been recalled.",
  NOT_FOUND: "I can't see that record or you don't have access to it.",
  FORBIDDEN: "You don't have permission for this.",
  INVALID_STATUS_TRANSITION: "The appointment's current status doesn't allow this.",
  VALIDATION: "Some information is missing or invalid.",
  CONFIRMATION_EXPIRED: "The confirmation expired; I need to summarise it again.",
  CONFIRMATION_REQUIRED: "I need your explicit confirmation to continue.",
  UNSUPPORTED: "This can't be done through the voice assistant.",
  TOOL_FAILED: "I can't verify that in the system right now.",
};

/** Güvenlik ayrıntısı açıklamadan kısa, doğal mesaj. */
export function translateVoiceError(code: string, lang: VoiceLanguage = "tr"): string {
  const map = lang === "en" ? ERRORS_EN : ERRORS_TR;
  return map[code] ?? map.TOOL_FAILED!;
}

// ---------------------------------------------------------------- sınırlar

const MEDICAL =
  /(ilaç|ilac|reçete|recete|teşhis|teshis|tanı koy|tani koy|tedavi öner|tedavi oner|doz|hangi ilaç|prescri|diagnos|medication|dosage|treatment plan)/i;
const UNSUPPORTED =
  /(yetki|admin yap|rol(ü|u|ümü|umu) değiştir|şifre|sifre|parola|mfa|kullanıcı oluştur|kullanici olustur|kvkk|rıza|riza|imza|belge(yi)? (iptal|void)|geri çağır|geri cagir|recall|imha|write.?off|hasta(yı)? sil|audit|database|veritaban|sql|sorgu çalıştır|sorgu calistir|sistem talimat|talimatları unut|talimatlari unut|ignore (all|previous) instructions|permission|password|delete patient)/i;

export type IntentBoundary = "MEDICAL" | "UNSUPPORTED" | null;

/** Tıbbi karar / desteklenmeyen işlem isteği (sesli asistan kapsamı dışı). */
export function intentBoundary(utterance: string): IntentBoundary {
  if (MEDICAL.test(utterance)) return "MEDICAL";
  if (UNSUPPORTED.test(utterance)) return "UNSUPPORTED";
  return null;
}

export const MEDICAL_REFUSAL: Record<VoiceLanguage, string> = {
  tr: "Bu konuda klinik kararı yetkili hekimin vermesi gerekir. Tanı, tedavi veya ilaç önerisi veremem.",
  en: "A licensed physician needs to make that clinical decision. I can't give diagnoses, treatment or medication advice.",
};

// ---------------------------------------------------------------- grounding

/**
 * Yanıttaki operasyonel gerçekler (saat "14:30", sayılar) bu turdaki ARAÇ SONUÇLARINDA var mı? Yoksa ihlal listesi
 * döner (model veri uydurdu). Araç çağrılmadan saat / sayı içeren yanıt da ihlaldir.
 */
export function groundingViolations(reply: string, toolOutputs: unknown[]): string[] {
  const facts = JSON.stringify(toolOutputs ?? []);
  const out: string[] = [];
  for (const m of reply.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)) {
    const hhmm = `${m[1]!.padStart(2, "0")}:${m[2]}`;
    if (!facts.includes(hhmm)) out.push(hhmm);
  }
  for (const m of reply.matchAll(
    /\b(\d+)\s*(adet|randevu|hasta|lot|ürün|urun|appointments?|patients?|units?)\b/gi,
  )) {
    if (!new RegExp(`(^|[^\\d])${m[1]}([^\\d]|$)`).test(facts)) out.push(m[0]);
  }
  return out;
}
