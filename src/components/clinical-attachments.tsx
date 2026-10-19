import { FileImage, FileText, Paperclip } from "lucide-react";
import { ActionForm, Field } from "@/components/action-form";
import { formatDateTime } from "@/components/patient-ui";
import { uploadClinicalAttachmentAction, voidClinicalAttachmentAction } from "@/app/actions/appointments";
import { cn } from "@/lib/cn";
import type { ClinicalAttachmentItem } from "@/types/clinical";

const size = (b: number) =>
  b < 1024 * 1024
    ? `${Math.max(1, Math.round(b / 1024))} KB`
    : `${(b / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;

/**
 * Muayene dosyaları (sağlık verisi). Dosyalar yalnızca yetki kontrollü uç üzerinden açılır (public URL yok); her
 * açılış audit'lenir. Geçersiz kılınan dosya listede gerekçesiyle görünür ama açılamaz.
 */
export function ClinicalAttachments({
  appointmentId,
  items,
  canUpload,
  canVoid,
  blockedReason,
}: {
  appointmentId: string;
  items: ClinicalAttachmentItem[];
  canUpload: boolean;
  canVoid: boolean;
  blockedReason: string | null;
}) {
  const active = items.filter((i) => i.status === "ACTIVE").length;
  return (
    <div className="mt-5 border-t border-line pt-4 dark:border-line-dark" data-testid="clinical-attachments">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Paperclip className="size-4 text-slate-400" aria-hidden="true" />
        Dosyalar
        <span className="text-xs font-normal text-slate-500">({active})</span>
      </h3>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Henüz dosya eklenmedi.</p>
      ) : (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {items.map((f) => {
            const Icon = f.mimeType === "application/pdf" ? FileText : FileImage;
            const voided = f.status === "VOIDED";
            return (
              <li
                key={f.id}
                className={cn(
                  "flex items-start gap-3 rounded-lg border border-line p-3 dark:border-line-dark",
                  voided && "opacity-60",
                )}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  {voided ? (
                    <span className="block truncate font-medium line-through">{f.fileName}</span>
                  ) : (
                    <a
                      href={`/api/v1/clinical-attachments/${f.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate font-medium text-brand-700 hover:underline dark:text-brand-300"
                    >
                      {f.fileName}
                    </a>
                  )}
                  <span className="block text-xs text-slate-500">
                    {size(f.sizeBytes)} · {f.authorName} · {formatDateTime(f.createdAt)}
                  </span>
                  {voided ? (
                    <span className="block text-xs text-red-600">Geçersiz: {f.voidReason}</span>
                  ) : null}
                  {!voided && canVoid ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs font-medium text-red-700 dark:text-red-400">
                        Geçersiz kıl
                      </summary>
                      <ActionForm
                        action={voidClinicalAttachmentAction}
                        submitLabel="Onayla"
                        className="mt-2 grid gap-2"
                      >
                        <input type="hidden" name="id" value={f.id} />
                        <input type="hidden" name="appointmentId" value={appointmentId} />
                        <Field
                          label="Gerekçe"
                          name="reason"
                          required
                          minLength={3}
                          maxLength={300}
                          hint="Dosya silinmez; gerekçesiyle geçersiz görünür."
                          idPrefix={`av-${f.id.slice(0, 8)}`}
                        />
                      </ActionForm>
                    </details>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {canUpload ? (
        <ActionForm
          action={uploadClinicalAttachmentAction}
          submitLabel="Dosyayı ekle"
          className="mt-3 flex flex-wrap items-end gap-3"
        >
          <input type="hidden" name="id" value={appointmentId} />
          <div className="min-w-0 flex-1">
            <label htmlFor="ca-file" className="label">
              Dosya ekle (PDF, PNG, JPEG, WEBP · en çok 5 MB)
            </label>
            <input
              id="ca-file"
              name="file"
              type="file"
              required
              accept="application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp"
              className="input py-2 file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1 file:text-sm file:font-medium file:text-brand-700 dark:file:bg-brand-500/10 dark:file:text-brand-300"
            />
          </div>
        </ActionForm>
      ) : blockedReason && items.length === 0 ? (
        <p className="hint mt-2">{blockedReason}</p>
      ) : null}
    </div>
  );
}
