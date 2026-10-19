import "server-only";
import { z } from "zod";
import { and, asc, desc, eq, gte, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { branches, clinicProfiles, patientTasks, patients, users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import {
  actorOf,
  branchFilter,
  hasPermission,
  requireBranchAccess,
  requirePermission,
  type AuthContext,
} from "@/server/auth/authz";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { loadVisiblePatient } from "@/server/services/patients";
import { loadAccessibleAppointment } from "@/server/services/appointments";
import { enqueueOutbox } from "@/server/notifications/outbox";
import { decryptField, encryptField } from "@/server/security/crypto";
import {
  DEFAULT_TIMEZONE,
  addDays,
  dateInZone,
  isValidDate,
  parseTime,
  zonedDateTimeToUtc,
} from "@/lib/time";
import { uuidSchema } from "@/server/validation";
import {
  TASK_TYPES,
  type PatientTaskItem,
  type TaskScope,
  type TaskStatus,
  type TaskType,
  type TaskView,
} from "@/types/tasks";

/**
 * HASTA GÖREVLERİ — arama / e-posta / görüşme hatırlatmaları.
 *
 *  - Görünürlük: task.manage → şube kapsamındaki tüm görevler; yalnızca task.read → kendine atanan veya kendi
 *    oluşturduğu görevler.
 *  - Oluşturma: task.create + hasta görünür olmalı. Atanan kişi görevin şubesinde task.read yetkisine sahip aktif bir
 *    kullanıcı olmalı (göremeyeceği hastaya görev atanamaz).
 *  - Güncelleme / kapatma: task.manage (kapsam içi) veya atanan kişi veya oluşturan. Kapanan görev değişmez (DB).
 *  - Başlık / not / sonuç şifreli (sağlık bilgisi içerebilir); audit'e ve bildirime yazılmaz.
 *  - Başkasına atanınca atanan kişiye uygulama içi bildirim (TASK_ASSIGNED; metinde hasta / başlık yok).
 */
const aadOf = (tenantId: string, id: string, field: "title" | "notes" | "result") =>
  `patient_task.${field}:${tenantId}:${id}`;

const optText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );
const optUuid = z.preprocess((v) => (v === "" || v === null ? undefined : v), uuidSchema.optional());
const timeSchema = z.string().refine((v) => parseTime(v) !== null, "Geçerli bir saat girin (SS:DD).");

const createInput = z.object({
  patientId: uuidSchema,
  appointmentId: optUuid,
  branchId: optUuid,
  taskType: z.enum(TASK_TYPES),
  title: z.string().trim().min(3, "Başlık en az 3 karakter.").max(160),
  notes: optText(1000),
  dueDate: z.string().refine(isValidDate, "Geçerli bir tarih girin."),
  dueTime: timeSchema,
  assigneeUserId: uuidSchema,
});
const editInput = z.object({
  title: z.string().trim().min(3).max(160).optional(),
  notes: optText(1000),
  taskType: z.enum(TASK_TYPES).optional(),
  dueDate: z.string().refine(isValidDate).optional(),
  dueTime: timeSchema.optional(),
  assigneeUserId: optUuid,
});
const closeInput = z.object({
  status: z.enum(["DONE", "UNREACHABLE", "CANCELLED"]),
  result: optText(1000),
});

async function tzOf(scope: TenantScope, branchId: string): Promise<string> {
  const [b] = await scope.tx
    .select({ tz: branches.timezone })
    .from(branches)
    .where(tenantWhere(branches, scope, eq(branches.id, branchId)));
  if (b?.tz) return b.tz;
  const [p] = await scope.tx
    .select({ tz: clinicProfiles.timezone })
    .from(clinicProfiles)
    .where(tenantWhere(clinicProfiles, scope));
  return p?.tz ?? DEFAULT_TIMEZONE;
}

/** Kullanıcı bu şubede task.read yetkisine sahip aktif bir kullanıcı mı (kiracı geneli rol veya şube rolü)? */
async function canBeAssigned(scope: TenantScope, userId: string, branchId: string): Promise<boolean> {
  const r = await scope.tx.execute<{ ok: boolean }>(sql`
    select exists (
      select 1 from kliniva.user_roles ur
        join kliniva.users u on u.id = ur.user_id and u.tenant_id = ur.tenant_id and u.active
        join kliniva.role_permissions rp on rp.role_id = ur.role_id
        join kliniva.permissions p on p.id = rp.permission_id and p.key = 'task.read'
       where ur.tenant_id = ${scope.tenantId}::uuid and ur.user_id = ${userId}::uuid
         and (ur.branch_id is null or ur.branch_id = ${branchId}::uuid)) as ok`);
  return Boolean(r.rows[0]?.ok);
}

/** Atanabilecek kişiler (seçim listesi). branchId verilirse o şubede görev görebilenler. */
export async function listAssignableUsers(
  ctx: AuthContext,
  branchId?: string,
): Promise<{ id: string; name: string }[]> {
  requirePermission(ctx, "task.create");
  return tenantQuery(ctx, async (scope) => {
    const b = branchId && uuidSchema.safeParse(branchId).success ? branchId : null;
    const r = await scope.tx.execute<{ id: string; name: string }>(sql`
      select distinct u.id, u.first_name || ' ' || u.last_name as name
        from kliniva.user_roles ur
        join kliniva.users u on u.id = ur.user_id and u.tenant_id = ur.tenant_id and u.active
        join kliniva.role_permissions rp on rp.role_id = ur.role_id
        join kliniva.permissions p on p.id = rp.permission_id and p.key = 'task.read'
       where ur.tenant_id = ${scope.tenantId}::uuid
         and (${b}::uuid is null or ur.branch_id is null or ur.branch_id = ${b}::uuid)
       order by name`);
    return r.rows;
  });
}

function visibilityCond(ctx: AuthContext, scopeAll: boolean): SQL | undefined {
  if (scopeAll && hasPermission(ctx, "task.manage")) return branchFilter(ctx, patientTasks.branchId);
  return or(eq(patientTasks.assignedUserId, ctx.userId), eq(patientTasks.createdByUserId, ctx.userId));
}

const canUpdateRow = (
  ctx: AuthContext,
  t: { assignedUserId: string; createdByUserId: string; branchId: string },
) =>
  t.assignedUserId === ctx.userId ||
  t.createdByUserId === ctx.userId ||
  (hasPermission(ctx, "task.manage") && (ctx.branchScope.all || ctx.branchScope.branchIds.has(t.branchId)));

export async function createTask(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "task.create");
  const data = parseInput(createInput, input);
  return tenantQuery(ctx, async (scope) => {
    const patient = await loadVisiblePatient(scope, ctx, data.patientId);
    let branchId = data.branchId;
    if (data.appointmentId) {
      const a = await loadAccessibleAppointment(scope, ctx, data.appointmentId);
      if (a.patientId !== patient.id) throw new AppError("NOT_FOUND");
      branchId = a.branchId;
    }
    if (!branchId) {
      if (
        patient.primaryBranchId &&
        (ctx.branchScope.all || ctx.branchScope.branchIds.has(patient.primaryBranchId))
      ) {
        branchId = patient.primaryBranchId;
      } else if (!ctx.branchScope.all && ctx.branchScope.branchIds.size === 1) {
        branchId = [...ctx.branchScope.branchIds][0];
      }
    }
    if (!branchId) throw new AppError("VALIDATION", { fields: ["branchId"], message: "Şube seçin." });
    // Doktor (kiracı geneli olabilir) randevudan şube alır; diğerleri kendi kapsamındaki şubeye görev açar.
    if (!data.appointmentId) requireBranchAccess(ctx, branchId);
    if (!(await canBeAssigned(scope, data.assigneeUserId, branchId))) {
      throw new AppError("VALIDATION", {
        fields: ["assigneeUserId"],
        message: "Seçilen kişiye bu şubede görev atanamaz.",
      });
    }
    const tz = await tzOf(scope, branchId);
    const dueAt = zonedDateTimeToUtc(data.dueDate, parseTime(data.dueTime)!, tz);
    const id = crypto.randomUUID();
    await scope.tx.insert(patientTasks).values({
      id,
      tenantId: scope.tenantId,
      branchId,
      patientId: patient.id,
      appointmentId: data.appointmentId ?? null,
      taskType: data.taskType,
      titleEncrypted: encryptField(data.title, aadOf(scope.tenantId, id, "title")),
      notesEncrypted: data.notes ? encryptField(data.notes, aadOf(scope.tenantId, id, "notes")) : null,
      dueAt,
      assignedUserId: data.assigneeUserId,
      createdByUserId: ctx.userId,
    });
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_TASK_CREATED",
      entityType: "patient_task",
      entityId: id,
      branchId,
      metadata: { taskType: data.taskType, assignedToSelf: data.assigneeUserId === ctx.userId },
    });
    if (data.assigneeUserId !== ctx.userId) {
      await enqueueOutbox(scope, {
        eventType: "TASK_ASSIGNED",
        aggregateType: "patient_task",
        aggregateId: id,
        payload: { assigneeUserId: data.assigneeUserId, actorUserId: ctx.userId },
      });
    }
    return { id };
  });
}

async function loadUpdatable(scope: TenantScope, ctx: AuthContext, rawId: unknown) {
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  const [t] = await scope.tx
    .select()
    .from(patientTasks)
    .where(tenantWhere(patientTasks, scope, eq(patientTasks.id, id.data)))
    .for("update");
  // Görülemeyen görev → NOT_FOUND (varlık sızdırılmaz).
  if (!t || !canUpdateRow(ctx, t)) throw new AppError("NOT_FOUND");
  if (t.status !== "OPEN") throw new AppError("CONFLICT", { message: "Görev kapanmış; değiştirilemez." });
  return t;
}

/** Açık görevi düzenler (başlık, not, tür, zaman, atanan). Atanan değişirse yeni kişiye bildirim. */
export async function editTask(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "task.read");
  const data = parseInput(editInput, input);
  await tenantQuery(ctx, async (scope) => {
    const t = await loadUpdatable(scope, ctx, rawId);
    const set: Partial<typeof patientTasks.$inferInsert> = { updatedAt: new Date() };
    const changed: string[] = [];
    if (data.title !== undefined) {
      set.titleEncrypted = encryptField(data.title, aadOf(scope.tenantId, t.id, "title"));
      changed.push("title");
    }
    if (data.notes !== undefined) {
      set.notesEncrypted = encryptField(data.notes, aadOf(scope.tenantId, t.id, "notes"));
      changed.push("notes");
    }
    if (data.taskType && data.taskType !== t.taskType) {
      set.taskType = data.taskType;
      changed.push("taskType");
    }
    if (data.dueDate && data.dueTime) {
      const tz = await tzOf(scope, t.branchId);
      set.dueAt = zonedDateTimeToUtc(data.dueDate, parseTime(data.dueTime)!, tz);
      changed.push("dueAt");
    }
    const reassigned = data.assigneeUserId && data.assigneeUserId !== t.assignedUserId;
    if (reassigned) {
      if (!(await canBeAssigned(scope, data.assigneeUserId!, t.branchId))) {
        throw new AppError("VALIDATION", {
          fields: ["assigneeUserId"],
          message: "Seçilen kişiye bu şubede görev atanamaz.",
        });
      }
      set.assignedUserId = data.assigneeUserId!;
      changed.push("assignee");
    }
    if (!changed.length) return;
    await scope.tx
      .update(patientTasks)
      .set(set)
      .where(tenantWhere(patientTasks, scope, eq(patientTasks.id, t.id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_TASK_UPDATED",
      entityType: "patient_task",
      entityId: t.id,
      branchId: t.branchId,
      metadata: { fields: changed.join(",") },
    });
    if (reassigned && data.assigneeUserId !== ctx.userId) {
      await enqueueOutbox(scope, {
        eventType: "TASK_ASSIGNED",
        aggregateType: "patient_task",
        aggregateId: t.id,
        payload: { assigneeUserId: data.assigneeUserId!, actorUserId: ctx.userId },
      });
    }
  });
}

/** Görevi kapatır: Tamamlandı / Ulaşılamadı / İptal (+ isteğe bağlı sonuç notu). Geri açılamaz. */
export async function closeTask(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "task.read");
  const data = parseInput(closeInput, input);
  await tenantQuery(ctx, async (scope) => {
    const t = await loadUpdatable(scope, ctx, rawId);
    await scope.tx
      .update(patientTasks)
      .set({
        status: data.status,
        resultEncrypted: data.result
          ? encryptField(data.result, aadOf(scope.tenantId, t.id, "result"))
          : null,
        completedAt: new Date(),
        completedByUserId: ctx.userId,
        updatedAt: new Date(),
      })
      .where(tenantWhere(patientTasks, scope, eq(patientTasks.id, t.id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_TASK_CLOSED",
      entityType: "patient_task",
      entityId: t.id,
      branchId: t.branchId,
      metadata: { status: data.status, hasResult: Boolean(data.result) },
    });
  });
}

/**
 * Görev listesi. scope "mine" → bana atanan; "all" → (task.manage) şube kapsamındaki tümü, aksi halde benim
 * atanan / oluşturduğum. Görünümler: açık, geciken, bugün, kapanan.
 */
export async function listTasks(
  ctx: AuthContext,
  opts: { scope?: TaskScope; view?: TaskView; patientId?: string; limit?: number } = {},
): Promise<PatientTaskItem[]> {
  requirePermission(ctx, "task.read");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return tenantQuery(ctx, async (scope) => {
    const [p] = await scope.tx
      .select({ tz: clinicProfiles.timezone })
      .from(clinicProfiles)
      .where(tenantWhere(clinicProfiles, scope));
    const tz = p?.tz ?? DEFAULT_TIMEZONE;
    const today = dateInZone(new Date(), tz);
    const dayStart = zonedDateTimeToUtc(today, 0, tz);
    const dayEnd = zonedDateTimeToUtc(addDays(today, 1), 0, tz);
    const now = new Date();
    const view = opts.view ?? "open";
    const patientId =
      opts.patientId && uuidSchema.safeParse(opts.patientId).success ? opts.patientId : undefined;
    if (patientId) await loadVisiblePatient(scope, ctx, patientId);
    const conds: (SQL | undefined)[] = [
      opts.scope === "mine" ? eq(patientTasks.assignedUserId, ctx.userId) : visibilityCond(ctx, true),
      patientId ? eq(patientTasks.patientId, patientId) : undefined,
      view === "done" ? sql`${patientTasks.status} <> 'OPEN'` : eq(patientTasks.status, "OPEN"),
      view === "overdue" ? lt(patientTasks.dueAt, now) : undefined,
      view === "today" ? and(gte(patientTasks.dueAt, dayStart), lt(patientTasks.dueAt, dayEnd)) : undefined,
    ];
    const assignee = alias(users, "assignee");
    const creator = alias(users, "creator");
    const completer = alias(users, "completer");
    const rows = await scope.tx
      .select({
        t: patientTasks,
        firstName: patients.firstName,
        lastName: patients.lastName,
        assigneeName: sql<string>`${assignee.firstName} || ' ' || ${assignee.lastName}`,
        creatorName: sql<string>`${creator.firstName} || ' ' || ${creator.lastName}`,
        completerName: sql<string | null>`${completer.firstName} || ' ' || ${completer.lastName}`,
        branchName: branches.name,
      })
      .from(patientTasks)
      .innerJoin(
        patients,
        and(eq(patients.tenantId, patientTasks.tenantId), eq(patients.id, patientTasks.patientId)),
      )
      .innerJoin(
        branches,
        and(eq(branches.tenantId, patientTasks.tenantId), eq(branches.id, patientTasks.branchId)),
      )
      .innerJoin(
        assignee,
        and(eq(assignee.tenantId, patientTasks.tenantId), eq(assignee.id, patientTasks.assignedUserId)),
      )
      .innerJoin(
        creator,
        and(eq(creator.tenantId, patientTasks.tenantId), eq(creator.id, patientTasks.createdByUserId)),
      )
      .leftJoin(
        completer,
        and(eq(completer.tenantId, patientTasks.tenantId), eq(completer.id, patientTasks.completedByUserId)),
      )
      .where(tenantWhere(patientTasks, scope, ...conds))
      .orderBy(view === "done" ? desc(patientTasks.completedAt) : asc(patientTasks.dueAt))
      .limit(limit);
    const dec = (v: string | null, id: string, f: "title" | "notes" | "result") => {
      if (!v) return null;
      try {
        return decryptField(v, aadOf(scope.tenantId, id, f));
      } catch {
        return "(doğrulanamadı)";
      }
    };
    return rows.map(({ t, ...r }) => ({
      id: t.id,
      patientId: t.patientId,
      patientName: `${r.firstName} ${r.lastName}`,
      appointmentId: t.appointmentId,
      taskType: t.taskType as TaskType,
      title: dec(t.titleEncrypted, t.id, "title") ?? "",
      notes: dec(t.notesEncrypted, t.id, "notes"),
      dueAt: t.dueAt.toISOString(),
      overdue: t.status === "OPEN" && t.dueAt < now,
      assignedUserId: t.assignedUserId,
      assigneeName: r.assigneeName,
      status: t.status as TaskStatus,
      result: dec(t.resultEncrypted, t.id, "result"),
      createdByName: r.creatorName,
      completedAt: t.completedAt?.toISOString() ?? null,
      completedByName: r.completerName,
      branchName: r.branchName,
      canUpdate: t.status === "OPEN" && canUpdateRow(ctx, t),
    }));
  });
}

/** Bana atanan açık görev sayıları (menü rozeti / panel). */
export async function getMyTaskCounts(
  ctx: AuthContext,
): Promise<{ open: number; overdue: number; today: number }> {
  requirePermission(ctx, "task.read");
  return tenantQuery(ctx, async (scope) => {
    const [p] = await scope.tx
      .select({ tz: clinicProfiles.timezone })
      .from(clinicProfiles)
      .where(tenantWhere(clinicProfiles, scope));
    const tz = p?.tz ?? DEFAULT_TIMEZONE;
    const today = dateInZone(new Date(), tz);
    const dayStart = zonedDateTimeToUtc(today, 0, tz).toISOString();
    const dayEnd = zonedDateTimeToUtc(addDays(today, 1), 0, tz).toISOString();
    const [r] = await scope.tx
      .select({
        open: sql<number>`count(*)::int`,
        overdue: sql<number>`count(*) filter (where ${patientTasks.dueAt} < now())::int`,
        today: sql<number>`count(*) filter (where ${patientTasks.dueAt} >= ${dayStart}::timestamptz and ${patientTasks.dueAt} < ${dayEnd}::timestamptz)::int`,
      })
      .from(patientTasks)
      .where(
        tenantWhere(
          patientTasks,
          scope,
          eq(patientTasks.assignedUserId, ctx.userId),
          eq(patientTasks.status, "OPEN"),
        ),
      );
    return { open: r?.open ?? 0, overdue: r?.overdue ?? 0, today: r?.today ?? 0 };
  });
}
