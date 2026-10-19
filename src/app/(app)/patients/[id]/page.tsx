import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { getPatient, getPatientActivity } from "@/server/services/patients";
import { getPatientConsentStates, listPatientDocuments, listTemplates } from "@/server/services/documents";
import { revokeConsentAction, voidDocumentAction } from "@/app/actions/patients";
import { listPatientAppointments } from "@/server/services/appointments";
import { listPatientMaterialUsage } from "@/server/services/material-usage";
import { MaterialUsageList } from "@/components/material-usage-list";
import { PatientAccountPanel } from "@/components/patient-account";
import { NewTaskForm, TaskList } from "@/components/patient-tasks";
import { LabEntry, LabResultList, LabTrends } from "@/components/lab-results";
import { listLabPanels, listLabResults } from "@/server/services/labs";
import { listAssignableUsers, listTasks } from "@/server/services/tasks";
import { clinicToday } from "@/server/services/appointments";
import { SectionCard } from "@/components/ui";
import { AllergyAlert, HealthProfileCard } from "@/components/health-profile";
import { SOCIAL_SECURITY_OPTIONS } from "@/types/patients";
import { getPatientAccount, listBillableServices } from "@/server/services/billing";
import { AppointmentStatusBadge, formatLocalDate } from "@/components/appointment-ui";
import type { AppointmentListItem } from "@/server/services/appointments";
import { ActionForm, Field, SelectField } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { NewDocumentButton } from "@/components/new-document-button";
import { Avatar, EmptyState, StatusBadge } from "@/components/ui";
import {
  AUDIT_ACTION_LABELS,
  CONSENT_LABELS,
  ConsentStateBadge,
  DocumentStatusBadge,
  PrivacyBadge,
  SIGNER_TYPE_LABELS,
  documentTitleOf,
  formatDate,
  formatDateTime,
} from "@/components/patient-ui";

export const metadata: Metadata = { title: "Hasta" };

type Tab =
  "overview" | "appointments" | "tasks" | "labs" | "account" | "materials" | "documents" | "activity";

const REVOKE_CHANNELS = [
  { value: "IN_PERSON", label: "Yüz yüze" },
  { value: "WRITTEN", label: "Yazılı dilekçe" },
  { value: "PHONE", label: "Telefon" },
  { value: "EMAIL", label: "E-posta" },
  { value: "PORTAL", label: "Portal" },
  { value: "OTHER", label: "Diğer" },
];

/**
 * Hasta dosyası. Sekmeler: Genel bakış · Randevular · Belgeler · Aktivite.
 * Tıbbi sekme bu sprintte YOK; sağlık notu bu ekranda gösterilmez.
 */
export default async function PatientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; panel?: string }>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "patient.read")) return <Forbidden />;
  const { id } = await params;
  const sp = await searchParams;

  let patient: Patient;
  try {
    patient = await getPatient(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }

  const canDocs = hasPermission(ctx, "patient.document.read");
  const canActivity = hasPermission(ctx, "audit.read");
  const canAppts = hasPermission(ctx, "appointment.read") || hasPermission(ctx, "appointment.read.own");
  const canMaterials = hasPermission(ctx, "inventory.usage.read");
  const canAccount = hasPermission(ctx, "billing.read");
  const canTasks = hasPermission(ctx, "task.read");
  const canLabs = hasPermission(ctx, "patient.health.read");
  const tab: Tab =
    sp.tab === "labs" && canLabs
      ? "labs"
      : sp.tab === "tasks" && canTasks
        ? "tasks"
        : sp.tab === "account" && canAccount
          ? "account"
          : sp.tab === "documents" && canDocs
            ? "documents"
            : sp.tab === "activity" && canActivity
              ? "activity"
              : sp.tab === "appointments" && canAppts
                ? "appointments"
                : sp.tab === "materials" && canMaterials
                  ? "materials"
                  : "overview";

  const tabs: { key: Tab; label: string; show: boolean; soon?: boolean }[] = [
    { key: "overview", label: "Genel bakış", show: true },
    { key: "appointments", label: "Randevular", show: canAppts },
    { key: "tasks", label: "Görevler", show: canTasks },
    { key: "labs", label: "Tahliller", show: canLabs },
    { key: "account", label: "Hesap", show: canAccount },
    { key: "materials", label: "Malzemeler", show: canMaterials },
    { key: "documents", label: "Belgeler", show: canDocs },
    { key: "activity", label: "Aktivite", show: canActivity },
  ];

  return (
    <section>
      <Link
        href="/patients"
        className="mb-3 inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-slate-500 transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:shadow-focus dark:text-slate-400 dark:hover:text-brand-300"
      >
        <span aria-hidden="true">←</span> Hastalar
      </Link>
      <div className="card mb-6 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-4 px-5 py-5">
          <Avatar name={`${patient.firstName} ${patient.lastName}`} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {patient.firstName} {patient.lastName}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
              <span className="font-mono text-xs">Hasta no {patient.patientNumber}</span>
              {patient.primaryBranchName ? <span>· {patient.primaryBranchName}</span> : null}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <PrivacyBadge status={patient.privacyStatus} />
              <StatusBadge active={patient.active} />
              {patient.sourceName ? <span className="badge badge-gray">{patient.sourceName}</span> : null}
              {patient.health?.profile?.allergies ? (
                <AllergyAlert allergies={patient.health.profile.allergies} compact />
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {hasPermission(ctx, "appointment.create") ? (
              <Link href={`/appointments/new?patient=${patient.id}`} className="btn-ghost btn-sm">
                Randevu ver
              </Link>
            ) : null}
            {hasPermission(ctx, "patient.update") ? (
              <Link href={`/patients/${patient.id}/edit`} className="btn btn-sm">
                Düzenle
              </Link>
            ) : null}
          </div>
        </div>
        <nav
          aria-label="Hasta sekmeleri"
          className="flex gap-1 overflow-x-auto border-t border-line px-3 dark:border-line-dark"
        >
          {tabs
            .filter((t) => t.show)
            .map((t) =>
              t.soon ? (
                <span
                  key={t.key}
                  aria-disabled="true"
                  className="flex min-h-11 shrink-0 items-center gap-2 px-3 text-sm text-slate-400"
                >
                  {t.label} <span className="badge badge-gray">Yakında</span>
                </span>
              ) : (
                <Link
                  key={t.key}
                  href={
                    t.key === "overview" ? `/patients/${patient.id}` : `/patients/${patient.id}?tab=${t.key}`
                  }
                  aria-current={tab === t.key ? "page" : undefined}
                  className={`relative flex min-h-11 shrink-0 items-center px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus ${
                    tab === t.key
                      ? "text-brand-700 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand-600 after:content-[''] dark:text-brand-300"
                      : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                  }`}
                >
                  {t.label}
                </Link>
              ),
            )}
        </nav>
      </div>

      {tab === "overview" ? <Overview ctx={ctx} patient={patient} canDocs={canDocs} /> : null}
      {tab === "documents" ? <Documents ctx={ctx} patientId={patient.id} /> : null}
      {tab === "activity" ? <Activity ctx={ctx} patientId={patient.id} /> : null}
      {tab === "appointments" ? <Appointments ctx={ctx} patientId={patient.id} /> : null}
      {tab === "materials" ? <Materials ctx={ctx} patientId={patient.id} /> : null}
      {tab === "account" ? <Account ctx={ctx} patientId={patient.id} /> : null}
      {tab === "tasks" ? <Tasks ctx={ctx} patientId={patient.id} /> : null}
      {tab === "labs" ? <Labs ctx={ctx} patientId={patient.id} panelId={sp.panel} /> : null}
    </section>
  );
}

type Ctx = Awaited<ReturnType<typeof requireUser>>;
type Patient = Awaited<ReturnType<typeof getPatient>>;

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words">{value || "—"}</dd>
    </div>
  );
}

async function Overview({ ctx, patient: p, canDocs }: { ctx: Ctx; patient: Patient; canDocs: boolean }) {
  const consents = canDocs ? await getPatientConsentStates(ctx, p.id) : [];
  const canRevoke = hasPermission(ctx, "patient.document.create");
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="card">
        <h2 className="mb-4 font-semibold">Kimlik ve iletişim</h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Info label="Telefon" value={p.phone} />
          <Info label="İkinci telefon" value={p.secondaryPhone} />
          <Info label="E-posta" value={p.email} />
          <Info label="Doğum tarihi" value={formatDate(p.birthDate)} />
          <Info label="TC kimlik no" value={p.nationalIdMasked} />
          <Info label="Uyruk" value={p.nationality} />
          <Info label="Adres" value={[p.address, p.district, p.city].filter(Boolean).join(", ")} />
          <Info
            label="Acil durumda aranacak kişi"
            value={
              p.emergencyContactName ? `${p.emergencyContactName} ${p.emergencyContactPhone ?? ""}` : null
            }
          />
          <Info label="Şubeler" value={p.branches.map((b) => b.name).join(", ")} />
          <Info label="Kayıt tarihi" value={formatDateTime(p.createdAt)} />
        </dl>
        <h2 className="mb-4 mt-6 border-t border-line pt-5 font-semibold dark:border-line-dark">
          Kaynak ve sigorta
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Info label="Hasta kaynağı" value={p.sourceName} />
          <Info label="Yönlendiren" value={p.referral} />
          <Info
            label="Sosyal güvence"
            value={SOCIAL_SECURITY_OPTIONS.find((o) => o.value === p.socialSecurity)?.label}
          />
          <Info label="Özel sigorta" value={p.insurerName} />
          <Info
            label="SMS"
            value={
              p.smsAllowed ? (
                <span className="badge badge-green">Gönderilebilir</span>
              ) : (
                <span className="badge badge-gray">İzin yok</span>
              )
            }
          />
        </dl>
      </div>

      <div className="grid content-start gap-6">
        {p.health ? (
          <HealthProfileCard
            patientId={p.id}
            profile={p.health.profile}
            canEdit={hasPermission(ctx, "patient.health.write")}
            integrityError={p.health.profileIntegrityError}
          />
        ) : null}
        {canDocs ? (
          <div className="card">
            <h2 className="mb-1 font-semibold">İletişim izinleri</h2>
            <p className="hint mb-4">Sorulmamış izin hiçbir zaman onay sayılmaz.</p>
            {consents.length === 0 ? (
              <p className="text-sm text-slate-500">Henüz açık rıza alınmadı.</p>
            ) : (
              <ul className="grid gap-3">
                {consents.map((c) => (
                  <li key={c.key} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">{CONSENT_LABELS[c.key] ?? c.key}</span>
                      <ConsentStateBadge state={c.state} />
                    </div>
                    {c.decidedAt ? (
                      <p className="mt-1 text-xs text-slate-500">{formatDateTime(c.decidedAt)}</p>
                    ) : null}
                    {c.state === "GRANTED" && canRevoke ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-sm text-red-700 dark:text-red-400">
                          Rızayı geri çek
                        </summary>
                        <ActionForm
                          action={revokeConsentAction}
                          submitLabel="Geri çek"
                          className="mt-3 grid gap-3"
                        >
                          <input type="hidden" name="patientId" value={p.id} />
                          <input type="hidden" name="key" value={c.key} />
                          <SelectField
                            label="Talep kanalı"
                            name="channel"
                            options={REVOKE_CHANNELS}
                            idPrefix={`rv-${c.key}`}
                          />
                          <Field
                            label="Not (isteğe bağlı)"
                            name="reason"
                            maxLength={300}
                            idPrefix={`rv-${c.key}`}
                          />
                        </ActionForm>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

async function Documents({ ctx, patientId }: { ctx: Ctx; patientId: string }) {
  const docs = await listPatientDocuments(ctx, patientId);
  const canPrepare =
    hasPermission(ctx, "patient.document.create") &&
    hasPermission(ctx, "patient.document.present") &&
    hasPermission(ctx, "patient.document.sign");
  const canSign = hasPermission(ctx, "patient.document.sign");
  const canVoid = hasPermission(ctx, "patient.document.void");
  const types = canPrepare
    ? [
        ...new Set((await listTemplates(ctx)).filter((t) => t.active && t.publishedAt).map((t) => t.type)),
      ].map((t) => ({ type: t, label: documentTitleOf(t) }))
    : [];
  const fileUrl = (docId: string, download = false) =>
    `/api/v1/patients/${patientId}/documents/${docId}/file${download ? "?download=1" : ""}`;

  return (
    <div className="grid gap-6">
      {canPrepare ? (
        <div className="card">
          <NewDocumentButton patientId={patientId} types={types} />
        </div>
      ) : null}
      {docs.length === 0 ? (
        <EmptyState title="Bu hastaya ait belge yok" />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Belge</th>
                <th scope="col">Sürüm</th>
                <th scope="col">Durum</th>
                <th scope="col">İmzalayan</th>
                <th scope="col">Tarih</th>
                <th scope="col">Şube</th>
                <th scope="col">
                  <span className="sr-only">İşlemler</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="font-medium">
                    {d.title}
                    <span className="block text-xs font-normal text-slate-500">{d.name}</span>
                  </td>
                  <td>v{d.documentVersion}</td>
                  <td>
                    <DocumentStatusBadge status={d.status} />
                    {d.status === "VOIDED" && d.voidReason ? (
                      <span className="mt-1 block max-w-48 text-xs text-slate-500">{d.voidReason}</span>
                    ) : null}
                  </td>
                  <td className="text-sm">
                    {d.signedByName ? (
                      <>
                        {d.signedByName}
                        <span className="block text-xs text-slate-500">
                          {SIGNER_TYPE_LABELS[d.signerType ?? "PATIENT"]}
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="whitespace-nowrap text-xs text-slate-500">
                    {formatDateTime(d.signedAt ?? d.createdAt)}
                  </td>
                  <td className="text-sm">{d.branchName}</td>
                  <td className="whitespace-nowrap text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      {d.signedAt ? (
                        <>
                          <a href={fileUrl(d.id)} target="_blank" rel="noopener" className="btn-ghost btn-sm">
                            PDF görüntüle
                          </a>
                          <a href={fileUrl(d.id, true)} className="btn-ghost btn-sm">
                            İndir
                          </a>
                        </>
                      ) : null}
                      {(d.status === "DRAFT" || d.status === "PRESENTED") && canSign ? (
                        <Link
                          href={`/patients/${patientId}/documents/sign?doc=${d.id}`}
                          className="btn btn-sm"
                        >
                          İmzalat
                        </Link>
                      ) : null}
                    </div>
                    {d.status === "SIGNED" && canVoid ? (
                      <details className="mt-2 text-left">
                        <summary className="cursor-pointer text-right text-xs text-red-700 dark:text-red-400">
                          Geçersiz kıl (VOID)
                        </summary>
                        <ActionForm
                          action={voidDocumentAction}
                          submitLabel="Geçersiz kıl"
                          className="mt-2 grid gap-2"
                        >
                          <input type="hidden" name="id" value={d.id} />
                          <input type="hidden" name="patientId" value={patientId} />
                          <Field
                            label="Gerekçe"
                            name="reason"
                            required
                            minLength={5}
                            maxLength={500}
                            idPrefix={`void-${d.id}`}
                            hint="Orijinal PDF ve hash korunur; belge silinmez."
                          />
                        </ActionForm>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

async function Activity({ ctx, patientId }: { ctx: Ctx; patientId: string }) {
  const items = await getPatientActivity(ctx, patientId, 100);
  if (!items.length) return <EmptyState title="Kayıtlı aktivite yok" />;
  return (
    <ol className="card grid p-0">
      {items.map((a) => (
        <li
          key={a.id}
          className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-5 py-3 last:border-0 dark:border-slate-800"
        >
          <span
            className={`text-sm ${a.action.endsWith("INTEGRITY_FAILED") ? "font-semibold text-red-700 dark:text-red-400" : ""}`}
          >
            {AUDIT_ACTION_LABELS[a.action] ?? a.action}
          </span>
          <span className="text-xs text-slate-500">
            {a.actorName ?? "Sistem"} · {formatDateTime(a.createdAt)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function AppointmentRows({ title, items }: { title: string; items: AppointmentListItem[] }) {
  return (
    <div className="card overflow-x-auto p-0">
      <h2 className="px-5 pt-5 font-semibold">{title}</h2>
      {items.length === 0 ? (
        <p className="px-5 pb-5 pt-2 text-sm text-slate-500">Kayıt yok.</p>
      ) : (
        <table className="table mt-3">
          <thead>
            <tr>
              <th scope="col">Tarih</th>
              <th scope="col">Doktor</th>
              <th scope="col">Şube</th>
              <th scope="col">Hizmet</th>
              <th scope="col">Durum</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap">
                  <Link href={`/appointments/${a.id}`} className="font-medium hover:text-brand-700">
                    {formatLocalDate(a.localDate)} · {a.localStart}
                  </Link>
                </td>
                <td>{a.doctor.name}</td>
                <td>{a.branch.name}</td>
                <td>{a.service?.name ?? "—"}</td>
                <td>
                  <AppointmentStatusBadge status={a.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

async function Appointments({ ctx, patientId }: { ctx: Ctx; patientId: string }) {
  const { upcoming, past } = await listPatientAppointments(ctx, patientId);
  return (
    <div className="grid gap-6">
      {hasPermission(ctx, "appointment.create") ? (
        <div>
          <Link href={`/appointments/new?patient=${patientId}`} className="btn">
            + Bu hastaya randevu
          </Link>
        </div>
      ) : null}
      <AppointmentRows title="Yaklaşan randevular" items={upcoming} />
      <AppointmentRows title="Geçmiş randevular" items={past} />
    </div>
  );
}

async function Materials({ ctx, patientId }: { ctx: Ctx; patientId: string }) {
  const rows = await listPatientMaterialUsage(ctx, { patientId });
  return (
    <div className="card p-0">
      <h2 className="px-5 pt-5 font-semibold">Malzeme kullanımları</h2>
      <div className="p-5 pt-3">
        <MaterialUsageList rows={rows} />
      </div>
    </div>
  );
}

async function Account({ ctx, patientId }: { ctx: Ctx; patientId: string }) {
  const can = {
    charge: hasPermission(ctx, "billing.charge"),
    payment: hasPermission(ctx, "billing.payment"),
    void: hasPermission(ctx, "billing.void"),
  };
  const [account, services] = await Promise.all([
    getPatientAccount(ctx, patientId),
    can.charge ? listBillableServices(ctx) : Promise.resolve([]),
  ]);
  return <PatientAccountPanel account={account} patientId={patientId} services={services} can={can} />;
}

async function Tasks({ ctx, patientId }: { ctx: Ctx; patientId: string }) {
  const canCreate = hasPermission(ctx, "task.create");
  const [open, done, assignees, today] = await Promise.all([
    listTasks(ctx, { patientId, view: "open" }),
    listTasks(ctx, { patientId, view: "done", limit: 20 }),
    canCreate ? listAssignableUsers(ctx) : Promise.resolve([]),
    clinicToday(ctx),
  ]);
  return (
    <div className="grid gap-6">
      {canCreate ? (
        <SectionCard
          title="Yeni görev"
          description="Arama, e-posta veya görüşme hatırlatması · atanan kişiye bildirim gider"
        >
          <NewTaskForm
            patientId={patientId}
            assignees={assignees}
            currentUserId={ctx.userId}
            defaultDate={today}
          />
        </SectionCard>
      ) : null}
      <SectionCard title="Açık görevler" description={`${open.length} görev`}>
        <TaskList tasks={open} showPatient={false} empty="Açık görev yok" />
      </SectionCard>
      {done.length ? (
        <SectionCard title="Kapanan görevler">
          <TaskList tasks={done} showPatient={false} />
        </SectionCard>
      ) : null}
    </div>
  );
}

async function Labs({ ctx, patientId, panelId }: { ctx: Ctx; patientId: string; panelId?: string }) {
  const canWrite = hasPermission(ctx, "patient.health.write");
  const [results, panels, today] = await Promise.all([
    listLabResults(ctx, patientId),
    canWrite ? listLabPanels(ctx, { activeOnly: true }) : Promise.resolve([]),
    clinicToday(ctx),
  ]);
  const selected = panels.find((p) => p.id === panelId) ?? null;
  return (
    <div className="grid gap-6">
      {canWrite ? <LabEntry patientId={patientId} panels={panels} selected={selected} today={today} /> : null}
      <LabTrends results={results} />
      <LabResultList patientId={patientId} results={results} canVoid={canWrite} />
    </div>
  );
}
