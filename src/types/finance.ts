/** Finans tipleri — istemci bileşenleri de kullanır (sunucu modülü import edilmez). Tutarlar kuruş / cent. */
export const CURRENCIES = ["TRY", "EUR", "USD", "GBP"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const PAYMENT_METHODS = ["CASH", "CARD", "TRANSFER", "OTHER"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "Nakit",
  CARD: "Kredi kartı",
  TRANSFER: "Havale / EFT",
  OTHER: "Diğer",
};

export type CashKind = "INCOME" | "EXPENSE";
export type FinanceStatus = "ACTIVE" | "VOIDED";

/** Para birimi → tutar (kuruş). Yalnızca sıfırdan farklı para birimleri bulunur. */
export type MoneyByCurrency = Partial<Record<Currency, number>>;

export type ChargeItem = {
  id: string;
  createdAt: string;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  totalMinor: number;
  currency: Currency;
  status: FinanceStatus;
  source: "APPOINTMENT" | "MANUAL";
  appointmentId: string | null;
  branchName: string;
  createdByName: string;
  voidReason: string | null;
  voidedAt: string | null;
};

export type PaymentItem = {
  id: string;
  occurredAt: string;
  amountMinor: number;
  currency: Currency;
  method: PaymentMethod;
  description: string | null;
  status: FinanceStatus;
  appointmentId: string | null;
  branchName: string;
  createdByName: string;
  voidReason: string | null;
  voidedAt: string | null;
};

export type PatientAccount = {
  charges: ChargeItem[];
  payments: PaymentItem[];
  charged: MoneyByCurrency;
  paid: MoneyByCurrency;
  /** charged − paid (pozitif = hastanın borcu, negatif = avans / fazla ödeme). */
  balance: MoneyByCurrency;
};

export type OpenBalanceRow = {
  patientId: string;
  patientName: string;
  patientNumber: string;
  phoneMasked: string;
  balance: MoneyByCurrency;
  lastActivityAt: string | null;
};

export type CashCategory = { id: string; name: string; kind: CashKind; active: boolean };

export type CashTransactionRow = {
  id: string;
  occurredAt: string;
  kind: CashKind;
  categoryName: string | null;
  method: PaymentMethod;
  amountMinor: number;
  currency: Currency;
  description: string | null;
  patientId: string | null;
  patientName: string | null;
  branchName: string;
  status: FinanceStatus;
  createdByName: string;
  voidReason: string | null;
};

export type CashPeriodTotals = { income: MoneyByCurrency; expense: MoneyByCurrency };

export type FinanceDashboard = {
  /** Bu ay (ayın 1'inden bugüne) tahsilat — TRY. */
  monthCollectedMinor: number;
  /** Geçen ayın AYNI dönemi (1'i → aynı gün) tahsilat — TRY; karşılaştırma için. */
  prevMonthSamePeriodMinor: number;
  /** TRY dışı para birimlerinde bu ay tahsilat (ayrı gösterilir, kur çevrimi yapılmaz). */
  monthCollectedOther: MoneyByCurrency;
  openBalanceMinor: number;
  openBalanceOther: MoneyByCurrency;
  openBalancePatients: number;
  /** Son 6 ay (eskiden yeniye) TRY gelir / gider. */
  months: { key: string; label: string; incomeMinor: number; expenseMinor: number }[];
  /** Son 90 gün en çok ciro yapan hizmetler (TRY, aktif hizmet bedelleri). */
  topServices: { name: string; totalMinor: number; count: number }[];
};
