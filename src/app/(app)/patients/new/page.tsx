import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { accessibleBranchOptions } from "@/server/services/org";
import { listTemplates } from "@/server/services/documents";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui";
import { PatientWizard } from "@/components/patient-wizard";

export const metadata: Metadata = { title: "Yeni hasta" };

/** Yeni hasta kaydı + KVKK aydınlatma + açık rıza + statik imza (5 adım). */
export default async function NewPatientPage() {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "patient.create")) return <Forbidden />;
  const branches = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];
  const canDocuments =
    hasPermission(ctx, "patient.document.create") &&
    hasPermission(ctx, "patient.document.present") &&
    hasPermission(ctx, "patient.document.sign");
  const published = canDocuments
    ? (await listTemplates(ctx)).filter((t) => t.active && t.publishedAt).map((t) => t.type)
    : [];

  return (
    <section className="max-w-4xl">
      <PageHeader
        title="Yeni hasta"
        description="Kayıt, KVKK aydınlatma ve açık rıza tek akışta. İmzalı belgeler değiştirilemez şekilde saklanır."
        back={{ href: "/patients", label: "Hastalar" }}
      />
      <PatientWizard
        branches={branches.map((b) => ({ id: b.id, name: b.name }))}
        defaultBranchId={branches.length === 1 ? branches[0]!.id : undefined}
        hasDisclosureTemplate={published.includes("KVKK_DISCLOSURE")}
        hasConsentTemplate={published.includes("EXPLICIT_CONSENT")}
      />
    </section>
  );
}
