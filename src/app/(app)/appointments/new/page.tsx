import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { clinicToday } from "@/server/services/appointments";
import { accessibleBranchOptions } from "@/server/services/org";
import { getPatient } from "@/server/services/patients";
import { maskPhoneNumber } from "@/lib/phone";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui";
import { AppointmentBooking } from "@/components/appointment-booking";
import { isValidDate } from "@/lib/time";

export const metadata: Metadata = { title: "Yeni randevu" };

export default async function NewAppointmentPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; patient?: string }>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "appointment.create") || !hasPermission(ctx, "appointment.availability.read")) {
    return <Forbidden />;
  }
  const sp = await searchParams;
  const today = await clinicToday(ctx);
  const branches = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];
  let initialPatient = null;
  if (sp.patient) {
    try {
      const p = await getPatient(ctx, sp.patient);
      initialPatient = {
        id: p.id,
        patientNumber: p.patientNumber,
        firstName: p.firstName,
        lastName: p.lastName,
        phoneMasked: maskPhoneNumber(p.phone),
      };
    } catch (e) {
      if (!isAppError(e)) throw e;
    }
  }

  return (
    <section>
      <PageHeader
        title="Yeni randevu"
        description="Uygun saatler doktor planı, şube saatleri, izinler, mevcut randevular ve oda uygunluğuna göre sunucuda hesaplanır."
        back={{ href: "/appointments", label: "Randevular" }}
      />
      <AppointmentBooking
        branches={branches.map((b) => ({ id: b.id, name: b.name }))}
        today={today}
        initialDate={sp.date && isValidDate(sp.date) && sp.date >= today ? sp.date : today}
        initialPatient={initialPatient}
      />
    </section>
  );
}
