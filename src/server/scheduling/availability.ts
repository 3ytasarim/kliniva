/**
 * Müsaitlik temeli — SAF hesaplama (DB yok → birim test edilebilir).
 *
 *   pencereler = doktor çalışma blokları (o gün, o şube)
 *              ∩ şube açılış saatleri (şubede etkinse)
 *              − doktor istisnaları (izin: tüm gün / saat aralığı)
 *              − şube kapanışları (tüm gün / saat aralığı)
 *   her pencere oda atamalarına göre parçalara bölünür:
 *              tarihli override > haftalık atama > oda atanmamış (roomId = null)
 *
 * Randevular (Sprint 2) bu pencerelerden ayrıca düşülecektir. Aralıklar yarı açık [start, end), dakika cinsinden.
 */
export type Interval = { start: number; end: number };
export type RoomInterval = Interval & { roomId: string; roomName: string };

export function normalize(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of normalize(a)) {
    for (const y of normalize(b)) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return normalize(out);
}

export function subtract(a: Interval[], cut: Interval[]): Interval[] {
  let current = normalize(a);
  for (const c of normalize(cut)) {
    const next: Interval[] = [];
    for (const x of current) {
      if (c.end <= x.start || c.start >= x.end) next.push(x);
      else {
        if (c.start > x.start) next.push({ start: x.start, end: c.start });
        if (c.end < x.end) next.push({ start: c.end, end: x.end });
      }
    }
    current = next;
  }
  return current;
}

export const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

export type AvailabilityInput = {
  working: Interval[];
  /** null → şube saat kısıtı yok; [] → şube o gün kapalı. */
  branchHours: Interval[] | null;
  exceptions: ({ allDay: true } | ({ allDay: false } & Interval))[];
  closures: ({ allDay: true } | ({ allDay: false } & Interval))[];
  weeklyRooms: RoomInterval[];
  datedRooms: RoomInterval[];
};

export type AvailabilitySegment = Interval & { roomId: string | null; roomName: string | null };

export function computeAvailability(input: AvailabilityInput): AvailabilitySegment[] {
  if (input.exceptions.some((e) => e.allDay) || input.closures.some((c) => c.allDay)) return [];
  let windows = normalize(input.working);
  if (input.branchHours) windows = intersect(windows, input.branchHours);
  windows = subtract(windows, [
    ...input.exceptions.filter((e): e is { allDay: false } & Interval => !e.allDay),
    ...input.closures.filter((c): c is { allDay: false } & Interval => !c.allDay),
  ]);

  const segments: AvailabilitySegment[] = [];
  for (const w of windows) {
    // 1) tarihli override'lar
    const dated = input.datedRooms.filter((r) => overlaps(r, w));
    for (const r of dated) {
      segments.push({
        start: Math.max(r.start, w.start),
        end: Math.min(r.end, w.end),
        roomId: r.roomId,
        roomName: r.roomName,
      });
    }
    // 2) override'ların kapsamadığı kısımda haftalık atamalar
    const remaining = subtract([w], dated);
    for (const part of remaining) {
      const weekly = input.weeklyRooms.filter((r) => overlaps(r, part));
      for (const r of weekly) {
        segments.push({
          start: Math.max(r.start, part.start),
          end: Math.min(r.end, part.end),
          roomId: r.roomId,
          roomName: r.roomName,
        });
      }
      // 3) oda atanmamış kalan süre
      for (const free of subtract([part], weekly)) segments.push({ ...free, roomId: null, roomName: null });
    }
  }
  return segments.sort((a, b) => a.start - b.start);
}
