/** Hasta ekranlarında ortak küçük bileşenler (sunucu bileşeni olarak kullanılabilir). */

export function PrivacyBadge({ status }: { status: "MISSING" | "PARTIAL" | "COMPLETE" }) {
  const map = {
    COMPLETE: { cls: "badge-green", label: "Tamamlandı" },
    PARTIAL: { cls: "badge-amber", label: "Bekliyor" },
    MISSING: { cls: "badge-gray", label: "Eksik" },
  } as const;
  const m = map[status];
  return <span className={`badge ${m.cls}`}>KVKK: {m.label}</span>;
}

export function DocumentStatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    DRAFT: { cls: "badge-gray", label: "Taslak" },
    PRESENTED: { cls: "badge-amber", label: "Sunuldu" },
    SIGNED: { cls: "badge-green", label: "İmzalı" },
    VOIDED: { cls: "badge-gray", label: "Geçersiz (VOID)" },
  };
  const m = map[status] ?? { cls: "badge-gray", label: status };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

export const CONSENT_LABELS: Record<string, string> = {
  MARKETING_SMS: "SMS ile kampanya / bilgilendirme",
  MARKETING_EMAIL: "E-posta ile kampanya / bilgilendirme",
  MARKETING_PHONE: "Telefon ile arama",
  MARKETING_WHATSAPP: "WhatsApp mesajı",
};

export function ConsentStateBadge({ state }: { state: "GRANTED" | "DENIED" | "REVOKED" | "NOT_ASKED" }) {
  const map = {
    GRANTED: { cls: "badge-green", label: "Onaylı" },
    DENIED: { cls: "badge-gray", label: "Reddedildi" },
    REVOKED: { cls: "badge-amber", label: "Geri çekildi" },
    NOT_ASKED: { cls: "badge-gray", label: "Sorulmadı" },
  } as const;
  const m = map[state];
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

export const formatDateTime = (d: Date | string | null | undefined) =>
  d
    ? new Intl.DateTimeFormat("tr-TR", {
        timeZone: "Europe/Istanbul",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(d))
    : "—";

export const formatDate = (d: string | null | undefined) =>
  d
    ? new Intl.DateTimeFormat("tr-TR", { dateStyle: "long", timeZone: "UTC" }).format(
        new Date(`${d}T00:00:00Z`),
      )
    : "—";

export { DOCUMENT_TYPE_LABELS, SIGNER_TYPE_LABELS, documentTitleOf } from "@/lib/document-labels";

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  PATIENT_CREATED: "Hasta kaydı oluşturuldu",
  PATIENT_UPDATED: "Hasta bilgileri güncellendi",
  PATIENT_VIEWED: "Hasta kaydı görüntülendi",
  PATIENT_DUPLICATE_WARNING: "Olası mükerrer kayıt uyarısı",
  PATIENT_DOCUMENT_CREATED: "Belge oluşturuldu",
  PATIENT_DOCUMENT_PRESENTED: "Belge hastaya sunuldu",
  PATIENT_DOCUMENT_SIGNED: "Belge imzalandı",
  PATIENT_DOCUMENT_VIEWED: "Belge görüntülendi",
  PATIENT_DOCUMENT_DOWNLOADED: "Belge indirildi",
  PATIENT_DOCUMENT_VOIDED: "Belge geçersiz kılındı",
  PATIENT_DOCUMENT_INTEGRITY_FAILED: "Belge bütünlük kontrolü BAŞARISIZ",
  CONSENT_GRANTED: "Açık rıza verildi",
  CONSENT_DENIED: "Açık rıza reddedildi",
  CONSENT_REVOKED: "Açık rıza geri çekildi",
};
