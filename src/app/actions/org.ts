"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/guards";
import { formToObject, runAction, type ActionState } from "@/server/action-result";
import { AppError } from "@/server/errors";
import { upsertClinicProfile, uploadClinicLogo } from "@/server/services/clinic";
import {
  createBranch,
  createBranchClosure,
  createRoom,
  deleteBranchClosure,
  setBranchActive,
  setBranchWorkingHours,
  setRoomActive,
  updateBranch,
  updateRoom,
} from "@/server/services/org";
import {
  assignDoctorBranch,
  createDoctor,
  removeDoctorBranch,
  updateDoctor,
} from "@/server/services/doctors";
import {
  addRoomAssignment,
  addScheduleException,
  addWorkingHour,
  changeAssignmentRoom,
  deleteRoomAssignment,
  deleteScheduleException,
  deleteWorkingHour,
  updateWorkingHour,
} from "@/server/services/schedule";
import { LOGO_MAX_BYTES } from "@/server/media/logo";

/** Sprint 1 server action'ları — her biri: requireUser() → servis (yetki + Zod + kiracı kapsamı + audit). */

const str = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};

// ---------------------------------------------------------------- klinik
export async function saveClinicProfileAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await upsertClinicProfile(await requireUser(), formToObject(form));
    revalidatePath("/settings/clinic");
    return "Klinik profili kaydedildi.";
  });
}

export async function uploadLogoAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await requireUser();
    const file = form.get("logo");
    if (!(file instanceof File) || file.size === 0) {
      throw new AppError("VALIDATION", { fields: ["logo"], message: "Lütfen bir logo dosyası seçin." });
    }
    // Dosya adı ve istemcinin bildirdiği MIME tipi KULLANILMAZ; içerik sunucuda doğrulanır.
    if (file.size > LOGO_MAX_BYTES) {
      throw new AppError("VALIDATION", { fields: ["logo"], message: "Logo en fazla 5 MB olabilir." });
    }
    await uploadClinicLogo(ctx, Buffer.from(await file.arrayBuffer()));
    revalidatePath("/settings/clinic");
    return "Logo güncellendi.";
  });
}

// ---------------------------------------------------------------- şubeler
export async function createBranchAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await createBranch(await requireUser(), formToObject(form));
    revalidatePath("/admin/branches");
    return "Şube oluşturuldu.";
  });
}

export async function updateBranchAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, ...rest } = formToObject(form);
    await updateBranch(await requireUser(), id, rest);
    revalidatePath("/admin/branches");
    return "Şube güncellendi.";
  });
}

export async function toggleBranchAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const active = str(form, "active") === "true";
    await setBranchActive(await requireUser(), str(form, "id"), active);
    revalidatePath("/admin/branches");
    return active ? "Şube aktifleştirildi." : "Şube pasifleştirildi.";
  });
}

export async function saveBranchHoursAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const days = [1, 2, 3, 4, 5, 6, 7].map((d) => ({
      dayOfWeek: d,
      enabled: str(form, `d${d}_enabled`) === "on",
      startTime: str(form, `d${d}_start`),
      endTime: str(form, `d${d}_end`),
    }));
    await setBranchWorkingHours(await requireUser(), str(form, "id"), {
      enabled: str(form, "workingHoursEnabled") === "on",
      days,
    });
    revalidatePath("/admin/branches");
    return "Çalışma saatleri kaydedildi.";
  });
}

export async function createClosureAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const data = formToObject(form);
    await createBranchClosure(await requireUser(), { ...data, allDay: data.allDay === "on" });
    revalidatePath("/admin/branches");
    return "Kapalı gün eklendi.";
  });
}

export async function deleteClosureAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await deleteBranchClosure(await requireUser(), str(form, "id"));
    revalidatePath("/admin/branches");
    return "Kapalı gün silindi.";
  });
}

// ---------------------------------------------------------------- odalar
export async function createRoomAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await createRoom(await requireUser(), formToObject(form));
    revalidatePath("/admin/rooms");
    return "Oda oluşturuldu.";
  });
}

export async function updateRoomAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, ...rest } = formToObject(form);
    await updateRoom(await requireUser(), id, rest);
    revalidatePath("/admin/rooms");
    return "Oda güncellendi.";
  });
}

export async function toggleRoomAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const active = str(form, "active") === "true";
    await setRoomActive(await requireUser(), str(form, "id"), active);
    revalidatePath("/admin/rooms");
    return active ? "Oda aktifleştirildi." : "Oda pasifleştirildi.";
  });
}

// ---------------------------------------------------------------- doktorlar
export async function createDoctorAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await createDoctor(await requireUser(), formToObject(form));
    revalidatePath("/admin/doctors");
    return "Doktor oluşturuldu.";
  });
}

export async function updateDoctorAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, active, ...rest } = formToObject(form);
    await updateDoctor(await requireUser(), id, {
      ...rest,
      ...(active !== undefined ? { active: active === "true" } : {}),
    });
    revalidatePath(`/admin/doctors/${id}`);
    return "Doktor güncellendi.";
  });
}

export async function assignDoctorBranchAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const doctorId = str(form, "doctorId");
    await assignDoctorBranch(await requireUser(), doctorId, str(form, "branchId"));
    revalidatePath(`/admin/doctors/${doctorId}`);
    return "Şube atandı.";
  });
}

export async function removeDoctorBranchAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const doctorId = str(form, "doctorId");
    await removeDoctorBranch(await requireUser(), doctorId, str(form, "branchId"));
    revalidatePath(`/admin/doctors/${doctorId}`);
    return "Şube bağı kaldırıldı.";
  });
}

// ---------------------------------------------------------------- planlama
const schedulePath = (form: FormData) => `/admin/doctors/${str(form, "doctorId")}/schedule`;

export async function addWorkingHourAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await addWorkingHour(await requireUser(), formToObject(form));
    revalidatePath(schedulePath(form));
    return "Çalışma bloğu eklendi.";
  });
}

export async function updateWorkingHourAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { id, ...rest } = formToObject(form);
    await updateWorkingHour(await requireUser(), id, rest);
    revalidatePath(schedulePath(form));
    return "Çalışma bloğu güncellendi.";
  });
}

export async function deleteWorkingHourAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await deleteWorkingHour(await requireUser(), str(form, "id"));
    revalidatePath(schedulePath(form));
    return "Çalışma bloğu silindi.";
  });
}

export async function addRoomAssignmentAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await addRoomAssignment(await requireUser(), formToObject(form));
    revalidatePath(schedulePath(form));
    return "Oda ataması eklendi.";
  });
}

export async function changeAssignmentRoomAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await changeAssignmentRoom(await requireUser(), str(form, "id"), str(form, "roomId"));
    revalidatePath(schedulePath(form));
    return "Oda değiştirildi.";
  });
}

export async function deleteRoomAssignmentAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await deleteRoomAssignment(await requireUser(), str(form, "id"));
    revalidatePath(schedulePath(form));
    return "Oda ataması silindi.";
  });
}

export async function addExceptionAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await addScheduleException(await requireUser(), formToObject(form));
    revalidatePath(schedulePath(form));
    return "İzin / çalışmama kaydı eklendi.";
  });
}

export async function deleteExceptionAction(_p: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await deleteScheduleException(await requireUser(), str(form, "id"));
    revalidatePath(schedulePath(form));
    return "Kayıt silindi.";
  });
}
