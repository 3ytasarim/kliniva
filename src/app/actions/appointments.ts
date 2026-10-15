"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/guards";
import { formToObject, runAction, runData, type ActionState, type DataResult } from "@/server/action-result";
import { listPatients } from "@/server/services/patients";
import {
  createClinicalService,
  listBookableDoctors,
  listClinicalServices,
  listDoctorServices,
  setDoctorServices,
  updateClinicalService,
} from "@/server/services/clinical-services";
import {
  approveAppointment,
  declineAppointment,
  cancelAppointment,
  createAppointment,
  getAvailableSlots,
  rescheduleAppointment,
  updateAppointmentNotes,
  updateAppointmentStatus,
} from "@/server/services/appointments";
import type { AvailableSlotsResult, BookingOption, PatientOption, ServiceOption } from "@/types/appointments";

/**
 * Randevu server action'ları — ince sarmalayıcı: requireUser() → uygulama servisi (yetki, kapsam, doğrulama,
 * audit servis katmanında). Müsaitlik YALNIZCA sunucuda hesaplanır; istemci slot listesini buradan alır.
 */

// ---------------------------------------------------------------- randevu sihirbazı (veri)
export async function searchPatientsAction(q: string): Promise<DataResult<PatientOption[]>> {
  return runData(async () => {
    const r = await listPatients(await requireUser(), { q, limit: 10 });
    return r.items.map((p) => ({
      id: p.id,
      patientNumber: p.patientNumber,
      firstName: p.firstName,
      lastName: p.lastName,
      phoneMasked: p.phoneMasked,
    }));
  });
}

export async function bookingServicesAction(doctorId?: string): Promise<DataResult<ServiceOption[]>> {
  return runData(async () => {
    const ctx = await requireUser();
    const list = doctorId
      ? (await listDoctorServices(ctx, doctorId)).map((s) => ({
          ...s,
          durationMinutes: s.effectiveDurationMinutes,
        }))
      : (await listClinicalServices(ctx, { activeOnly: true })).map((s) => ({
          ...s,
          durationMinutes: s.defaultDurationMinutes,
        }));
    return list.map((s) => ({
      id: s.id,
      name: s.name,
      durationMinutes: s.durationMinutes,
      requiresRoom: s.requiresRoom,
    }));
  });
}

export async function bookingDoctorsAction(input: {
  branchId: string;
  serviceId?: string;
}): Promise<DataResult<BookingOption[]>> {
  return runData(async () =>
    (await listBookableDoctors(await requireUser(), input)).map((d) => ({ id: d.id, name: d.name })),
  );
}

export async function availableSlotsAction(input: {
  branchId: string;
  doctorId: string;
  serviceId?: string;
  date: string;
  patientId?: string;
  excludeAppointmentId?: string;
}): Promise<DataResult<AvailableSlotsResult>> {
  return runData(async () => getAvailableSlots(await requireUser(), input));
}

export async function createAppointmentAction(input: {
  patientId: string;
  branchId: string;
  doctorId: string;
  serviceId?: string;
  start: string;
  roomId?: string;
  notes?: string;
}): Promise<DataResult<{ id: string }>> {
  return runData(async () => {
    const r = await createAppointment(await requireUser(), input);
    revalidatePath("/appointments");
    return r;
  });
}

export async function rescheduleAppointmentAction(input: {
  id: string;
  start: string;
  roomId?: string;
}): Promise<DataResult<{ id: string }>> {
  return runData(async () => {
    await rescheduleAppointment(await requireUser(), input.id, { start: input.start, roomId: input.roomId });
    revalidatePath(`/appointments/${input.id}`);
    return { id: input.id };
  });
}

// ---------------------------------------------------------------- durum / iptal / not (form)
export async function appointmentStatusAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, status } = formToObject(form);
    await updateAppointmentStatus(await requireUser(), id, { status });
    revalidatePath(`/appointments/${id}`);
    revalidatePath("/doctor");
    revalidatePath("/dashboard");
    revalidatePath("/operations/today");
    return "Randevu durumu güncellendi.";
  });
}

/** Doktor onayı — yalnızca KENDİ onay bekleyen randevusu (servis doktor eşleşmesini zorunlu tutar). */
export async function approveAppointmentAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id } = formToObject(form);
    await approveAppointment(await requireUser(), id);
    revalidatePath(`/appointments/${id}`);
    revalidatePath("/doctor");
    revalidatePath("/appointments");
    return "Randevu onaylandı.";
  });
}

export async function declineAppointmentAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id } = formToObject(form);
    await declineAppointment(await requireUser(), id);
    revalidatePath(`/appointments/${id}`);
    revalidatePath("/doctor");
    revalidatePath("/appointments");
    return "Randevu reddedildi; slot yeniden müsait.";
  });
}

export async function cancelAppointmentAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, reason } = formToObject(form);
    await cancelAppointment(await requireUser(), id, { reason });
    revalidatePath(`/appointments/${id}`);
    return "Randevu iptal edildi (kayıt ve geçmiş korunur).";
  });
}

export async function appointmentNotesAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, notes } = formToObject(form);
    await updateAppointmentNotes(await requireUser(), id, { notes: notes ?? "" });
    revalidatePath(`/appointments/${id}`);
    return "Not kaydedildi.";
  });
}

// ---------------------------------------------------------------- hizmet yönetimi
function serviceForm(form: FormData): Record<string, string | string[]> & { id?: string } {
  return { ...formToObject(form), allowedRoomTypes: form.getAll("allowedRoomTypes").map(String) };
}

export async function createServiceAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await createClinicalService(await requireUser(), serviceForm(form));
    revalidatePath("/settings/services");
    return "Hizmet eklendi.";
  });
}

export async function updateServiceAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = serviceForm(form);
    await updateClinicalService(await requireUser(), data.id, data);
    revalidatePath("/settings/services");
    return "Hizmet güncellendi.";
  });
}

/** Form: doctorId + serviceId (çoklu) + override_<serviceId> (isteğe bağlı süre). */
export async function setDoctorServicesAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const doctorId = String(form.get("doctorId") ?? "");
    const services = form.getAll("serviceId").map((v) => {
      const serviceId = String(v);
      return { serviceId, durationMinutesOverride: String(form.get(`override_${serviceId}`) ?? "") };
    });
    await setDoctorServices(await requireUser(), { doctorId, services });
    revalidatePath(`/admin/doctors/${doctorId}`);
    revalidatePath("/settings/services");
    return "Doktorun hizmetleri güncellendi.";
  });
}
