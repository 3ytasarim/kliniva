import Link from "next/link";
import { UNIT_LABELS, UsageStatusBadge } from "@/components/inventory-ui";
import { formatDateTime } from "@/components/patient-ui";
import { formatQuantity } from "@/lib/quantity";

/** Hasta dosyası "Malzemeler" ve randevu "Kullanılan malzemeler" listesi (sunucu bileşeni). */
export type MaterialUsageRow = {
  id: string;
  status: "DRAFT" | "FINALIZED" | "VOIDED";
  createdAt: Date;
  appointmentId: string | null;
  appointmentStart: Date | null;
  branchName: string;
  roomName: string | null;
  doctorName: string | null;
  items: {
    itemName: string;
    unit: string;
    quantity: string;
    /** Hasta izlenebilirliği: kullanılan lot numaraları (yalnızca lot görüntüleme yetkisiyle dolu). */
    lots?: { lotNumber: string; quantity: string }[];
  }[];
};

export function MaterialUsageList({
  rows,
  showAppointment = true,
}: {
  rows: MaterialUsageRow[];
  showAppointment?: boolean;
}) {
  if (!rows.length) return <p className="text-sm text-slate-500">Malzeme kullanımı kaydı yok.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Tarih</th>
            {showAppointment ? <th scope="col">Randevu</th> : null}
            <th scope="col">Doktor</th>
            <th scope="col">Şube / oda</th>
            <th scope="col">Malzemeler</th>
            <th scope="col">Durum</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td className="whitespace-nowrap">
                <Link href={`/inventory/usages/${u.id}`} className="font-medium hover:text-brand-700">
                  {formatDateTime(u.createdAt)}
                </Link>
              </td>
              {showAppointment ? (
                <td className="whitespace-nowrap text-xs">
                  {u.appointmentId && u.appointmentStart ? (
                    <Link
                      href={`/appointments/${u.appointmentId}`}
                      className="text-brand-700 hover:underline"
                    >
                      {formatDateTime(u.appointmentStart)}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
              ) : null}
              <td>{u.doctorName ?? "—"}</td>
              <td>
                {u.branchName}
                {u.roomName ? ` · ${u.roomName}` : ""}
              </td>
              <td className="text-sm">
                {u.items.length ? (
                  <ul className="grid gap-1">
                    {u.items.map((i, n) => (
                      <li key={n}>
                        {`${i.itemName} ×${formatQuantity(i.quantity)} ${UNIT_LABELS[i.unit] ?? ""}`.trim()}
                        {i.lots?.length ? (
                          <span
                            className="block font-mono text-xs text-slate-500"
                            data-testid="material-lots"
                          >
                            Lot:{" "}
                            {i.lots.map((l) => `${l.lotNumber} ×${formatQuantity(l.quantity)}`).join(", ")}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "—"
                )}
              </td>
              <td>
                <UsageStatusBadge status={u.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
