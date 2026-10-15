import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { getDocumentPreview } from "@/server/services/documents";
import { DocumentSignForm } from "@/components/document-sign";
import { Forbidden } from "@/components/forbidden";

export const metadata: Metadata = { title: "Belge imzalama" };

/**
 * Tablet odak modu: tek belge, büyük yazı, büyük dokunma hedefleri, kenar menü yok (768px'te kullanılabilir).
 * Belge bu hastaya ait değilse / başka kiracıdaysa 404.
 */
export default async function SignDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ doc?: string }>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "patient.document.sign")) return <Forbidden />;
  const { id } = await params;
  const { doc: docId } = await searchParams;
  const returnHref = `/patients/${id}?tab=documents`;

  let doc: Awaited<ReturnType<typeof getDocumentPreview>>;
  try {
    doc = await getDocumentPreview(ctx, docId);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  if (doc.patientId !== id) notFound();

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Belge imzalama</h1>
        <Link href={returnHref} className="btn-ghost">
          Vazgeç
        </Link>
      </header>
      {doc.status === "SIGNED" || doc.status === "VOIDED" ? (
        <div role="status" className="card">
          <p className="font-medium">
            {doc.status === "SIGNED" ? "Bu belge zaten imzalanmış." : "Bu belge geçersiz kılınmış."}
          </p>
          <Link href={returnHref} className="mt-3 inline-flex font-medium text-brand-700">
            Hasta belgelerine dön
          </Link>
        </div>
      ) : (
        <DocumentSignForm doc={doc} returnHref={returnHref} />
      )}
    </div>
  );
}
