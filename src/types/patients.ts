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
