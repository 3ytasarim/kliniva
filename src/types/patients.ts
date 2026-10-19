/**
 * Hasta / belge ekranlarında istemci ve sunucunun paylaştığı TİPLER (çalışma zamanı kodu yok).
 * İstemci bileşenleri sunucu modüllerini import edemez (ESLint); ortak sözleşme burada durur.
 */
export const DOCUMENT_TYPES = [
  "KVKK_DISCLOSURE",
  "EXPLICIT_CONSENT",
  "TREATMENT_CONSENT",
  "COMMERCIAL_COMMUNICATION_CONSENT",
  "OTHER",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Şablondaki seçim tanımı: ACKNOWLEDGEMENT → yalnızca READ_AND_INFORMED; CONSENT → GRANTED / DENIED. */
export type TemplateChoice = {
  key: string;
  label: string;
  kind: "ACKNOWLEDGEMENT" | "CONSENT";
  required: boolean;
};

/** Belgede sabitlenen içerik snapshot'ı (şifreli saklanır). */
export type DocumentSnapshot = {
  templateId: string;
  type: DocumentType;
  title: string;
  name: string;
  version: number;
  content: string;
  choices: TemplateChoice[];
};

/** İmza ekranına giden önizleme: snapshot + özeti (imzada geri gönderilir → TOCTOU koruması). */
export type DocumentPreview = {
  documentId: string;
  patientId: string;
  patientName: string;
  patientNumber: string;
  status: string;
  snapshot: DocumentSnapshot;
  contentSha256: string;
};

export type DuplicateCandidate = {
  id: string;
  patientNumber: string;
  firstName: string;
  lastName: string;
  matchedOn: ("PHONE" | "EMAIL" | "NAME_BIRTHDATE")[];
};

// ---------------------------------------------------------------- Sprint 8.1: hasta kartı
export type PatientLookupKind = "SOURCE" | "INSURER";
export type PatientLookup = { id: string; kind: PatientLookupKind; name: string; active: boolean };

export const SOCIAL_SECURITY_OPTIONS = [
  { value: "NONE", label: "Yok (ücretli)" },
  { value: "SGK", label: "SGK" },
  { value: "BAG_KUR", label: "Bağ-Kur" },
  { value: "EMEKLI_SANDIGI", label: "Emekli Sandığı" },
  { value: "GSS", label: "Genel Sağlık Sigortası" },
  { value: "OTHER", label: "Diğer" },
] as const;
export type SocialSecurity = (typeof SOCIAL_SECURITY_OPTIONS)[number]["value"];

export const BLOOD_TYPES = [
  "0 Rh+",
  "0 Rh-",
  "A Rh+",
  "A Rh-",
  "B Rh+",
  "B Rh-",
  "AB Rh+",
  "AB Rh-",
] as const;
export const HABIT_OPTIONS = [
  { value: "NEVER", label: "Hiç kullanmadı" },
  { value: "FORMER", label: "Bıraktı" },
  { value: "OCCASIONAL", label: "Ara sıra" },
  { value: "REGULAR", label: "Düzenli" },
] as const;
export type Habit = (typeof HABIT_OPTIONS)[number]["value"];

/** [HEALTH_SPECIAL_CATEGORY] Şifreli saklanır; yalnızca patient.health.read ile döner. */
export type HealthProfile = {
  bloodType: string | null;
  allergies: string;
  chronicConditions: string;
  medications: string;
  smoking: Habit | null;
  alcohol: Habit | null;
};

/** Hasta listesi segmentleri (kayıtlı filtreler). */
export const PATIENT_SEGMENTS = [
  { key: "upcoming", label: "Yaklaşan randevusu olan" },
  { key: "balance", label: "Açık bakiyesi olan" },
  { key: "lapsed", label: "90+ gündür gelmeyen" },
  { key: "returning", label: "Tekrar gelen (2+)" },
  { key: "no_visit", label: "Hiç ziyareti yok" },
  { key: "new_month", label: "Bu ay kayıt" },
] as const;
export type PatientSegment = (typeof PATIENT_SEGMENTS)[number]["key"];
