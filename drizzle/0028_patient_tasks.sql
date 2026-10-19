CREATE TYPE "kliniva"."task_status" AS ENUM('OPEN', 'DONE', 'UNREACHABLE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "kliniva"."task_type" AS ENUM('OUTGOING_CALL', 'INCOMING_CALL', 'EMAIL', 'SMS', 'MEETING', 'OTHER');--> statement-breakpoint
ALTER TYPE "kliniva"."notification_type" ADD VALUE 'TASK_ASSIGNED';--> statement-breakpoint
CREATE TABLE "kliniva"."patient_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"task_type" "kliniva"."task_type" NOT NULL,
	"title_encrypted" text NOT NULL,
	"notes_encrypted" text,
	"due_at" timestamp with time zone NOT NULL,
	"assigned_user_id" uuid NOT NULL,
	"status" "kliniva"."task_status" DEFAULT 'OPEN' NOT NULL,
	"result_encrypted" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" uuid,
	CONSTRAINT "patient_tasks_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_tasks_completion_ck" CHECK (("kliniva"."patient_tasks"."status" = 'OPEN' and "kliniva"."patient_tasks"."completed_at" is null and "kliniva"."patient_tasks"."completed_by_user_id" is null) or ("kliniva"."patient_tasks"."status" <> 'OPEN' and "kliniva"."patient_tasks"."completed_at" is not null and "kliniva"."patient_tasks"."completed_by_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "kliniva"."patient_tasks" ADD CONSTRAINT "patient_tasks_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "kliniva"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_tasks" ADD CONSTRAINT "patient_tasks_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "kliniva"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_tasks" ADD CONSTRAINT "patient_tasks_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "kliniva"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_tasks" ADD CONSTRAINT "patient_tasks_assignee_fk" FOREIGN KEY ("tenant_id","assigned_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_tasks" ADD CONSTRAINT "patient_tasks_creator_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kliniva"."patient_tasks" ADD CONSTRAINT "patient_tasks_completer_fk" FOREIGN KEY ("tenant_id","completed_by_user_id") REFERENCES "kliniva"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_tasks_assignee_idx" ON "kliniva"."patient_tasks" USING btree ("tenant_id","assigned_user_id","status","due_at");--> statement-breakpoint
CREATE INDEX "patient_tasks_patient_idx" ON "kliniva"."patient_tasks" USING btree ("tenant_id","patient_id","due_at");--> statement-breakpoint
CREATE INDEX "patient_tasks_branch_idx" ON "kliniva"."patient_tasks" USING btree ("tenant_id","branch_id","status","due_at");