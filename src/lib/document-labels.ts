/** Belge türü / imzalayan etiketleri — PDF, ekranlar ve testler aynı kaynağı kullanır. */
export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  KVKK_DISCLOSURE: "KVKK Aydınlatma Metni",
  EXPLICIT_CONSENT: "Açık Rıza Beyanı",
  TREATMENT_CONSENT: "Tedavi Onam Formu",
  COMMERCIAL_COMMUNICATION_CONSENT: "Ticari Elektronik İleti Onayı",
  OTHER: "Belge",
};

export const documentTitleOf = (type: string) => DOCUMENT_TYPE_LABELS[type] ?? "Belge";

export const SIGNER_TYPE_LABELS: Record<string, string> = {
  PATIENT: "Hasta",
  PARENT: "Veli",
  LEGAL_GUARDIAN: "Yasal temsilci",
};
