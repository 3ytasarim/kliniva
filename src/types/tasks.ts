/** Hasta görevi tipleri — istemci / sunucu ortak. */
export const TASK_TYPES = ["OUTGOING_CALL", "INCOMING_CALL", "EMAIL", "SMS", "MEETING", "OTHER"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  OUTGOING_CALL: "Giden arama",
  INCOMING_CALL: "Gelen arama",
  EMAIL: "E-posta",
  SMS: "SMS",
  MEETING: "Görüşme / toplantı",
  OTHER: "Diğer",
};

export const TASK_STATUSES = ["OPEN", "DONE", "UNREACHABLE", "CANCELLED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  OPEN: "Açık",
  DONE: "Tamamlandı",
  UNREACHABLE: "Ulaşılamadı",
  CANCELLED: "İptal",
};

export type PatientTaskItem = {
  id: string;
  patientId: string;
  patientName: string;
  appointmentId: string | null;
  taskType: TaskType;
  title: string;
  notes: string | null;
  dueAt: string;
  overdue: boolean;
  assignedUserId: string;
  assigneeName: string;
  status: TaskStatus;
  result: string | null;
  createdByName: string;
  completedAt: string | null;
  completedByName: string | null;
  branchName: string;
  /** Oturumdaki kullanıcı bu görevi kapatabilir / düzenleyebilir mi (sunucu ayrıca doğrular). */
  canUpdate: boolean;
};

export type TaskScope = "mine" | "all";
export type TaskView = "open" | "overdue" | "today" | "done";
