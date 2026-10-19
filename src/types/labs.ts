/** Tahlil tipleri — istemci / sunucu ortak. */
export type LabParameter = {
  /** Parametre adından türetilen kararlı anahtar (değişim tablosu bu anahtarla eşleşir). */
  key: string;
  name: string;
  unit: string;
  low: number | null;
  high: number | null;
};
export type LabPanel = { id: string; name: string; parameters: LabParameter[]; active: boolean };

export type LabFlag = "L" | "H" | null;
export type LabValue = LabParameter & { value: string; flag: LabFlag };

export type LabResultItem = {
  id: string;
  panelId: string;
  panelName: string;
  sampleDate: string;
  values: LabValue[];
  abnormalCount: number;
  status: "ACTIVE" | "VOIDED";
  voidReason: string | null;
  createdByName: string;
  createdAt: string;
  integrityError: boolean;
};

export const LAB_FLAG_LABELS: Record<"L" | "H", string> = { L: "Düşük", H: "Yüksek" };
