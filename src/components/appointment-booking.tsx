"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  availableSlotsAction,
  bookingDoctorsAction,
  bookingServicesAction,
  createAppointmentAction,
  searchPatientsAction,
} from "@/app/actions/appointments";
import { SLOT_REASON_LABELS, formatLocalDate } from "@/components/appointment-ui";
import type {
  AvailableSlot,
  AvailableSlotsResult,
  BookingOption,
  PatientOption,
  ServiceOption,
} from "@/types/appointments";

/**
 * Yeni randevu: Hasta → Şube → Hizmet → Doktor → Tarih → Uygun saat → Oda → Özet → Oluştur.
 * Müsaitlik İSTEMCİDE HESAPLANMAZ: saatler sunucunun slot yanıtından gelir; oluşturma sırasında sunucu aynı hesabı
 * yeniden yapar (yarış durumunda "artık uygun değil" döner ve liste yenilenir).
 */
type Branch = { id: string; name: string };

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="card grid gap-3">
      <legend className="sr-only">{title}</legend>
      <div className="flex items-center gap-3" aria-hidden="true">
        <span
          className={`grid size-8 place-items-center rounded-full text-sm font-semibold ${
            done
              ? "bg-brand-600 text-white"
              : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          }`}
        >
          {done ? "✓" : n}
        </span>
        <h2 className="font-semibold">{title}</h2>
      </div>
      {children}
    </fieldset>
  );
}

export function AppointmentBooking({
  branches,
  initialDate,
  today,
  initialPatient,
}: {
  branches: Branch[];
  initialDate: string;
  today: string;
  initialPatient?: PatientOption | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [patients, setPatients] = useState<PatientOption[] | null>(null);
  const [patient, setPatient] = useState<PatientOption | null>(initialPatient ?? null);
  const [branchId, setBranchId] = useState(branches.length === 1 ? branches[0]!.id : "");
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [doctors, setDoctors] = useState<BookingOption[]>([]);
  const [doctorId, setDoctorId] = useState("");
  const [date, setDate] = useState(initialDate);
  const [result, setResult] = useState<AvailableSlotsResult | null>(null);
  const [slot, setSlot] = useState<AvailableSlot | null>(null);
  const [roomId, setRoomId] = useState("");
  const [notes, setNotes] = useState("");
  const [loadingSlots, setLoadingSlots] = useState(false);

  // Hizmetler (aktif). Doktor seçilince yalnızca o doktorun verdikleri.
  useEffect(() => {
    let live = true;
    void bookingServicesAction(doctorId || undefined).then((r) => {
      if (!live) return;
      if (r.ok) setServices(r.data);
      else setError(r.message);
    });
    return () => {
      live = false;
    };
  }, [doctorId]);

  type Sel = { branchId: string; serviceId: string; doctorId: string; date: string; patientId?: string };
  /**
   * Son seçim ref'te tutulur: yanıtlar kullanıcı başka bir şey seçtikten SONRA dönebilir. Eski yanıtlar
   * (istek sayacıyla) yok sayılır, doktor listesi yanıtı kullanıcının daha yeni doktor seçimini ezmez.
   */
  const latest = useRef<Sel>({ branchId, serviceId, doctorId, date, patientId: patient?.id });
  const slotReq = useRef(0);
  const doctorReq = useRef(0);

  /** Uygun saatler — YALNIZCA sunucudan. */
  const fetchSlots = (sel: Sel) => {
    const req = ++slotReq.current;
    setSlot(null);
    setRoomId("");
    setResult(null);
    if (!sel.branchId || !sel.doctorId || !sel.date) {
      setLoadingSlots(false);
      return;
    }
    setLoadingSlots(true);
    void availableSlotsAction({
      branchId: sel.branchId,
      doctorId: sel.doctorId,
      serviceId: sel.serviceId || undefined,
      date: sel.date,
      patientId: sel.patientId,
    }).then((r) => {
      if (req !== slotReq.current) return; // daha yeni bir istek var
      setLoadingSlots(false);
      if (r.ok) setResult(r.data);
      else setError(r.message);
    });
  };

  /** Şube + hizmete göre doktorlar; seçili doktor (en GÜNCEL seçim) listede yoksa temizlenir. */
  const fetchDoctors = (sel: Sel) => {
    const req = ++doctorReq.current;
    if (!sel.branchId) {
      setDoctors([]);
      setDoctorId("");
      latest.current = { ...latest.current, doctorId: "" };
      fetchSlots(latest.current);
      return;
    }
    void bookingDoctorsAction({ branchId: sel.branchId, serviceId: sel.serviceId || undefined }).then((r) => {
      if (req !== doctorReq.current) return;
      if (!r.ok) return setError(r.message);
      setDoctors(r.data);
      const now = latest.current;
      if (now.doctorId && !r.data.some((d) => d.id === now.doctorId)) {
        setDoctorId("");
        latest.current = { ...now, doctorId: "" };
      }
      fetchSlots(latest.current);
    });
  };

  // İlk yükleme: tek şube varsa doktorları getir (setState yalnızca geri çağrıda).
  useEffect(() => {
    if (!branchId) return;
    void bookingDoctorsAction({ branchId }).then((r) => {
      if (r.ok) setDoctors(r.data);
    });
    // yalnızca ilk render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const change = (patch: Partial<Sel>) => {
    setError(null);
    const next = { ...latest.current, ...patch };
    latest.current = next;
    if ("branchId" in patch || "serviceId" in patch) fetchDoctors(next);
    else fetchSlots(next);
  };

  const search = () =>
    start(async () => {
      setError(null);
      const r = await searchPatientsAction(q);
      if (r.ok) setPatients(r.data);
      else setError(r.message);
    });

  const book = () =>
    start(async () => {
      setError(null);
      if (!patient || !slot) return;
      const r = await createAppointmentAction({
        patientId: patient.id,
        branchId,
        doctorId,
        serviceId: serviceId || undefined,
        start: slot.startUtc,
        roomId: roomId || undefined,
        notes: notes || undefined,
      });
      if (r.ok) {
        router.push(`/appointments/${r.data.id}`);
        return;
      }
      // Slot başka biri tarafından alındıysa listeyi yenile; hata mesajı görünür kalır.
      fetchSlots(latest.current);
      setError(r.message);
    });

  const service = services.find((s) => s.id === serviceId);
  const doctor = doctors.find((d) => d.id === doctorId);
  const branch = branches.find((b) => b.id === branchId);
  const room = slot?.rooms.find((r) => r.roomId === roomId);
  const ready = Boolean(patient && branchId && doctorId && slot);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <div className="grid gap-4">
        <Step n={1} title="Hasta" done={Boolean(patient)}>
          {patient ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 p-3 dark:bg-slate-800">
              <span>
                <span className="font-medium">
                  {patient.firstName} {patient.lastName}
                </span>{" "}
                <span className="font-mono text-xs text-slate-500">{patient.patientNumber}</span>
              </span>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => {
                  setPatient(null);
                  change({ patientId: undefined });
                }}
              >
                Değiştir
              </button>
            </div>
          ) : (
            <>
              <form
                className="flex flex-wrap gap-2"
                role="search"
                onSubmit={(e) => {
                  e.preventDefault();
                  search();
                }}
              >
                <label htmlFor="bk-q" className="sr-only">
                  Hasta ara
                </label>
                <input
                  id="bk-q"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Hasta no, ad soyad veya telefon"
                  className="input min-w-0 flex-1"
                  minLength={2}
                  autoComplete="off"
                />
                <button type="submit" className="btn-ghost" disabled={pending || q.trim().length < 2}>
                  Ara
                </button>
              </form>
              {patients ? (
                patients.length ? (
                  <ul className="grid gap-1" aria-label="Arama sonuçları">
                    {patients.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setPatient(p);
                            change({ patientId: p.id });
                          }}
                          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 text-left text-sm hover:border-brand-500 hover:bg-brand-50 dark:border-slate-700 dark:hover:bg-brand-900"
                        >
                          <span className="font-medium">
                            {p.firstName} {p.lastName}
                          </span>
                          <span className="font-mono text-xs text-slate-500">
                            {p.patientNumber} · {p.phoneMasked}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-500">Eşleşen hasta yok.</p>
                )
              ) : null}
            </>
          )}
        </Step>

        <Step n={2} title="Şube ve hizmet" done={Boolean(branchId && serviceId)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="bk-branch" className="label">
                Şube
              </label>
              <select
                id="bk-branch"
                value={branchId}
                onChange={(e) => {
                  setBranchId(e.target.value);
                  change({ branchId: e.target.value });
                }}
                className="input"
              >
                <option value="">Seçin</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="bk-service" className="label">
                Hizmet
              </label>
              <select
                id="bk-service"
                value={serviceId}
                onChange={(e) => {
                  setServiceId(e.target.value);
                  change({ serviceId: e.target.value });
                }}
                className="input"
              >
                <option value="">Hizmet seçin</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.durationMinutes} dk
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Step>

        <Step n={3} title="Doktor ve tarih" done={Boolean(doctorId && date)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="bk-doctor" className="label">
                Doktor
              </label>
              <select
                id="bk-doctor"
                value={doctorId}
                onChange={(e) => {
                  setDoctorId(e.target.value);
                  change({ doctorId: e.target.value });
                }}
                className="input"
                disabled={!branchId}
              >
                <option value="">
                  {branchId ? (doctors.length ? "Doktor seçin" : "Uygun doktor yok") : "Önce şube seçin"}
                </option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="bk-date" className="label">
                Tarih
              </label>
              <input
                id="bk-date"
                type="date"
                min={today}
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  change({ date: e.target.value });
                }}
                className="input"
              />
            </div>
          </div>
        </Step>

        <Step n={4} title="Uygun saat ve oda" done={Boolean(slot)}>
          {!doctorId ? (
            <p className="text-sm text-slate-500">Uygun saatler doktor ve tarih seçilince listelenir.</p>
          ) : loadingSlots ? (
            <p role="status" className="text-sm text-slate-500">
              Uygun saatler hesaplanıyor…
            </p>
          ) : result && result.slots.length === 0 ? (
            <p role="status" className="text-sm text-slate-600 dark:text-slate-400">
              {SLOT_REASON_LABELS[result.reason] || "Uygun saat yok."}
            </p>
          ) : result ? (
            <>
              <p className="text-xs text-slate-500">
                {formatLocalDate(result.date)} · {result.durationMinutes} dk · saatler {result.timezone}{" "}
                saatiyle
              </p>
              <div
                className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6"
                role="radiogroup"
                aria-label="Uygun saatler"
              >
                {result.slots.map((s) => (
                  <button
                    key={s.startUtc}
                    type="button"
                    role="radio"
                    aria-checked={slot?.startUtc === s.startUtc}
                    onClick={() => {
                      setSlot(s);
                      setRoomId(s.rooms[0]?.roomId ?? "");
                    }}
                    className={`min-h-11 rounded-lg border text-sm font-medium tabular-nums transition-colors ${
                      slot?.startUtc === s.startUtc
                        ? "border-brand-600 bg-brand-600 text-white"
                        : "border-slate-200 hover:border-brand-500 hover:bg-brand-50 dark:border-slate-700 dark:hover:bg-brand-900"
                    }`}
                  >
                    {s.start}
                  </button>
                ))}
              </div>
              {slot && slot.rooms.length ? (
                <div className="max-w-xs">
                  <label htmlFor="bk-room" className="label">
                    Oda
                  </label>
                  <select
                    id="bk-room"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    className="input"
                  >
                    {!result.requiresRoom ? <option value="">Oda atanmasın</option> : null}
                    {slot.rooms.map((r) => (
                      <option key={r.roomId} value={r.roomId}>
                        {r.roomName}
                      </option>
                    ))}
                  </select>
                  <p className="hint">
                    Sistem uygun odayı önerir; yalnızca o saatte boş ve uygun tipteki odalar listelenir.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
        </Step>
      </div>

      <aside className="card grid gap-4 lg:sticky lg:top-6" aria-labelledby="bk-review">
        <h2 id="bk-review" className="font-semibold">
          Özet
        </h2>
        <dl className="grid gap-2 text-sm">
          {[
            ["Hasta", patient ? `${patient.firstName} ${patient.lastName}` : "—"],
            ["Şube", branch?.name ?? "—"],
            ["Hizmet", service ? `${service.name} (${service.durationMinutes} dk)` : "—"],
            ["Doktor", doctor?.name ?? "—"],
            ["Tarih", date ? formatLocalDate(date) : "—"],
            ["Saat", slot ? `${slot.start}–${slot.end}` : "—"],
            ["Oda", room?.roomName ?? (slot ? "Atanmayacak" : "—")],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-right font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        <div>
          <label htmlFor="bk-notes" className="label">
            Operasyon notu (isteğe bağlı)
          </label>
          <textarea
            id="bk-notes"
            rows={2}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="input"
            aria-describedby="bk-notes-hint"
          />
          <p id="bk-notes-hint" className="hint">
            Tıbbi bilgi yazmayın; not şifreli saklanır.
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <button type="button" className="btn min-h-12" disabled={!ready || pending} onClick={book}>
          {pending ? "Oluşturuluyor…" : "Randevuyu oluştur"}
        </button>
      </aside>
    </div>
  );
}
