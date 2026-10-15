"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { availableSlotsAction, rescheduleAppointmentAction } from "@/app/actions/appointments";
import { SLOT_REASON_LABELS } from "@/components/appointment-ui";
import type { AvailableSlot, AvailableSlotsResult } from "@/types/appointments";

/** Randevu taşıma: yeni tarih → sunucudan uygun saatler → seç → taşı (sunucu atomik olarak doğrular). */
export function AppointmentReschedule({
  appointmentId,
  branchId,
  doctorId,
  serviceId,
  patientId,
  initialDate,
  today,
}: {
  appointmentId: string;
  branchId: string;
  doctorId: string;
  serviceId: string | null;
  patientId: string;
  initialDate: string;
  today: string;
}) {
  const router = useRouter();
  const [date, setDate] = useState(initialDate);
  const [result, setResult] = useState<AvailableSlotsResult | null>(null);
  const [slot, setSlot] = useState<AvailableSlot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = (d: string) =>
    start(async () => {
      setError(null);
      setSlot(null);
      const r = await availableSlotsAction({
        branchId,
        doctorId,
        serviceId: serviceId ?? undefined,
        date: d,
        patientId,
        excludeAppointmentId: appointmentId,
      });
      if (r.ok) setResult(r.data);
      else setError(r.message);
    });

  const submit = () =>
    start(async () => {
      if (!slot) return;
      setError(null);
      const r = await rescheduleAppointmentAction({
        id: appointmentId,
        start: slot.startUtc,
        roomId: slot.rooms[0]?.roomId,
      });
      if (r.ok) {
        router.refresh();
        setResult(null);
        setSlot(null);
      } else {
        setError(r.message);
        load(date);
      }
    });

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="rs-date" className="label">
            Yeni tarih
          </label>
          <input
            id="rs-date"
            type="date"
            min={today}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="input"
          />
        </div>
        <button type="button" className="btn-ghost" disabled={pending || !date} onClick={() => load(date)}>
          Uygun saatleri getir
        </button>
      </div>
      {result ? (
        result.slots.length ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" role="radiogroup" aria-label="Yeni saat">
            {result.slots.map((s) => (
              <button
                key={s.startUtc}
                type="button"
                role="radio"
                aria-checked={slot?.startUtc === s.startUtc}
                onClick={() => setSlot(s)}
                className={`min-h-11 rounded-lg border text-sm font-medium tabular-nums ${
                  slot?.startUtc === s.startUtc
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-slate-200 hover:border-brand-500 dark:border-slate-700"
                }`}
              >
                {s.start}
              </button>
            ))}
          </div>
        ) : (
          <p role="status" className="text-sm text-slate-500">
            {SLOT_REASON_LABELS[result.reason] || "Uygun saat yok."}
          </p>
        )
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div>
        <button type="button" className="btn" disabled={!slot || pending} onClick={submit}>
          {pending ? "İşleniyor…" : slot ? `${slot.start} saatine taşı` : "Saat seçin"}
        </button>
      </div>
    </div>
  );
}
