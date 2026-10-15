import Link from "next/link";

/** Stok ekranlarında ortak etiketler ve alt menü (sunucu / istemci bileşeni olarak kullanılabilir). */
export const UNIT_LABELS: Record<string, string> = {
  PIECE: "Adet",
  BOX: "Kutu",
  PACK: "Paket",
  BOTTLE: "Şişe",
  ML: "ml",
  LITER: "Litre",
  GRAM: "Gram",
  KG: "kg",
  PAIR: "Çift",
  SET: "Set",
  OTHER: "Diğer",
};

export const MOVEMENT_LABELS: Record<string, string> = {
  INITIAL_STOCK: "İlk stok",
  PURCHASE: "Alım / giriş",
  ADJUSTMENT_IN: "Düzeltme (+)",
  ADJUSTMENT_OUT: "Düzeltme (−)",
  TRANSFER: "Transfer",
  PATIENT_USAGE: "Hasta kullanımı",
  RETURN_FROM_PATIENT_USAGE: "Kullanım iadesi (VOID)",
  WRITE_OFF: "Fire / imha",
};

export const LOCATION_TYPE_LABELS: Record<string, string> = {
  BRANCH_WAREHOUSE: "Şube deposu",
  ROOM: "Oda",
};

export function UsageStatusBadge({ status }: { status: "DRAFT" | "FINALIZED" | "VOIDED" }) {
  const m = {
    DRAFT: ["badge-amber", "Taslak"],
    FINALIZED: ["badge-green", "Kesinleşti"],
    VOIDED: ["badge-gray", "Geçersiz (VOID)"],
  } as const;
  return <span className={`badge ${m[status][0]}`}>{m[status][1]}</span>;
}

export type LotStatusCode =
  "AVAILABLE" | "LOW_STOCK" | "EXPIRING_SOON" | "EXPIRED" | "DEPLETED" | "INACTIVE" | "RECALLED";

export const LOT_STATUS_LABELS: Record<LotStatusCode, [string, string]> = {
  AVAILABLE: ["badge-green", "Kullanılabilir"],
  LOW_STOCK: ["badge-amber", "Düşük"],
  EXPIRING_SOON: ["badge-amber", "SKT yaklaşıyor"],
  EXPIRED: ["badge-red", "SKT geçmiş"],
  DEPLETED: ["badge-gray", "Tükendi"],
  INACTIVE: ["badge-gray", "Pasif"],
  RECALLED: ["badge-red", "Geri çağrıldı"],
};

export function LotStatusBadge({ status }: { status: LotStatusCode }) {
  const [cls, label] = LOT_STATUS_LABELS[status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

/** "YYYY-MM-DD" → "GG.AA.YYYY" (SKT bir takvim günüdür; saat dilimi dönüşümü YAPILMAZ). */
export function formatExpiry(date: string | null): string {
  if (!date) return "—";
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}

const TABS = [
  { href: "/inventory", label: "Panel" },
  { href: "/inventory/items", label: "Ürünler" },
  { href: "/inventory/expiry", label: "SKT takibi" },
  { href: "/inventory/locations", label: "Lokasyonlar" },
  { href: "/inventory/templates", label: "Hizmet şablonları" },
];

export function InventoryNav({ current }: { current: string }) {
  return (
    <nav
      aria-label="Stok menüsü"
      className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
    >
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={current === t.href ? "page" : undefined}
          className={`flex min-h-11 shrink-0 items-center border-b-2 px-4 text-sm font-medium ${
            current === t.href
              ? "border-brand-600 text-brand-700 dark:text-brand-100"
              : "border-transparent text-slate-600 hover:text-brand-700 dark:text-slate-400"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
