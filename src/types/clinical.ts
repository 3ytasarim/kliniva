/** Muayene dosyası tipleri — istemci / sunucu ortak (sunucu modülü import edilmez). */
export type AttachmentMime = "application/pdf" | "image/png" | "image/jpeg" | "image/webp";
export type ClinicalAttachmentItem = {
  id: string;
  fileName: string;
  mimeType: AttachmentMime;
  sizeBytes: number;
  createdAt: string;
  authorName: string;
  status: "ACTIVE" | "VOIDED";
  voidReason: string | null;
};
