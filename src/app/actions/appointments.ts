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
  startExamination,
  updateAppointmentNotes,
  updateAppointmentStatus,
} from "@/server/services/appointments";
import { saveClinicalNote } from "@/server/services/clinical-notes";
import {
  ATTACHMENT_MAX_BYTES,
  uploadClinicalAttachment,
  voidClinicalAttachment,
} from "@/server/services/clinical-attachments";
import { AppError } from "@/server/errors";
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

const revalidateAppointmentViews = (id: string) => {
  revalidatePath(`/appointments/${id}`);
  revalidatePath("/appointments");
  revalidatePath("/doctor");
  revalidatePath("/dashboard");
  revalidatePath("/operations/today");
};

/** Tek tıkla muayeneyi başlat (GELDİ gerekiyorsa önce o; bkz. startExamination). */
export async function startExaminationAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id } = formToObject(form);
    await startExamination(await requireUser(), id);
    revalidateAppointmentViews(String(id));
    return "Muayene başladı.";
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

/** Muayene kaydı (sağlık verisi) — yeni sürüm olarak kaydeder; aynı içerik yeni sürüm üretmez. */
export async function saveClinicalNoteAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, complaint, history, findings, procedures, plan, advice } = formToObject(form);
    const r = await saveClinicalNote(await requireUser(), id, {
      complaint,
      history,
      findings,
      procedures,
      plan,
      advice,
    });
    revalidatePath(`/appointments/${String(id)}`);
    return r.unchanged
      ? "Değişiklik yok; kayıt aynı kaldı."
      : `Muayene kaydı kaydedildi (sürüm ${r.version}).`;
  });
}

// ---------------------------------------------------------------- Sprint 8.2: muayene dosyaları
export async function uploadClinicalAttachmentAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const id = form.get("id");
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new AppError("VALIDATION", { fields: ["file"], message: "Lütfen bir dosya seçin." });
    }
    // İstemcinin bildirdiği MIME kullanılmaz; tür içerikten belirlenir. Boyut önce burada da kontrol edilir.
    if (file.size > ATTACHMENT_MAX_BYTES) {
      throw new AppError("VALIDATION", { fields: ["file"], message: "Dosya en fazla 5 MB olabilir." });
    }
    await uploadClinicalAttachment(await requireUser(), id, {
      name: file.name,
      data: Buffer.from(await file.arrayBuffer()),
    });
    revalidatePath(`/appointments/${String(id)}`);
    return "Dosya eklendi.";
  });
}

export async function voidClinicalAttachmentAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, appointmentId, reason } = formToObject(form);
    await voidClinicalAttachment(await requireUser(), id, { reason });
    revalidatePath(`/appointments/${appointmentId}`);
    return "Dosya geçersiz kılındı.";
  });
}
