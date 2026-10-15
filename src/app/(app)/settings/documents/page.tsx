import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { DOCUMENT_TYPES, getTemplate, listTemplates } from "@/server/services/documents";
import { createTemplateVersionAction, publishTemplateAction } from "@/app/actions/patients";
import { ActionForm, Field, InlineAction, SelectField } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader } from "@/components/ui";
import { documentTitleOf, formatDateTime } from "@/components/patient-ui";

export const metadata: Metadata = { title: "Belge şablonları" };

const TYPE_OPTIONS = DOCUMENT_TYPES.map((t) => ({ value: t, label: documentTitleOf(t) }));

/**
 * KVKK / rıza şablonları. Yayımlanmış şablon DÜZENLENEMEZ: metin değişikliği her zaman yeni versiyon oluşturur.
 * Hastaya sunulan belge, oluşturulduğu andaki şablonun değişmez snapshot'ını taşır.
 */
export default async function DocumentTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "document.template.manage")) return <Forbidden />;
  const sp = await searchParams;
  const templates = await listTemplates(ctx);
  let selected: Awaited<ReturnType<typeof getTemplate>> | null = null;
  if (sp.id) {
    try {
      selected = await getTemplate(ctx, sp.id);
    } catch (e) {
      if (!(isAppError(e) && e.code === "NOT_FOUND")) throw e;
    }
  }
  const choicesText = (selected?.choices ?? [])
    .map((c) => `${c.key}|${c.label}|${c.kind}|${c.required ? "evet" : "hayır"}`)
    .join("\n");

  return (
    <section>
      <PageHeader
        title="Belge şablonları"
        description="KVKK aydınlatma, açık rıza ve onam metinleri. Yayımlanan sürüm değiştirilemez; yeni sürüm oluşturun."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="card overflow-x-auto p-0">
          {templates.length === 0 ? (
            <div className="p-6">
              <EmptyState title="Şablon yok" />
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Şablon</th>
                  <th scope="col">Sürüm</th>
                  <th scope="col">Durum</th>
                  <th scope="col">
                    <span className="sr-only">İşlemler</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => {
                  const state = !t.publishedAt ? "draft" : t.active ? "live" : "old";
                  return (
                    <tr key={t.id} aria-current={selected?.id === t.id ? "true" : undefined}>
                      <td>
                        <Link
                          href={`/settings/documents?id=${t.id}`}
                          className="font-medium hover:text-brand-700"
                        >
                          {documentTitleOf(t.type)}
                        </Link>
                        <span className="block text-xs text-slate-500">
                          {t.name}
                          {t.tenantId ? "" : " · platform varsayılanı"}
                        </span>
                      </td>
                      <td>v{t.version}</td>
                      <td>
                        <span
                          className={`badge ${state === "live" ? "badge-green" : state === "draft" ? "badge-amber" : "badge-gray"}`}
                        >
                          {state === "live" ? "Yayında" : state === "draft" ? "Taslak" : "Eski sürüm"}
                        </span>
                        {t.publishedAt ? (
                          <span className="mt-1 block text-xs text-slate-500">
                            {formatDateTime(t.publishedAt)}
                          </span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap text-right">
                        {state === "draft" && t.tenantId ? (
                          <InlineAction
                            action={publishTemplateAction}
                            fields={{ id: t.id }}
                            label="Yayımla"
                            variant="primary"
                            confirm="Bu sürüm yayımlanınca değiştirilemez. Devam edilsin mi?"
                          />
                        ) : (
                          <Link href={`/settings/documents?id=${t.id}`} className="btn-ghost btn-sm">
                            Önizle
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="grid content-start gap-6">
          {selected ? (
            <article className="card grid gap-3" aria-labelledby="tpl-preview">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="tpl-preview" className="font-semibold">
                  Önizleme · {documentTitleOf(selected.type)} v{selected.version}
                </h2>
                {selected.publishedAt ? <span className="badge badge-gray">Salt okunur</span> : null}
              </div>
              <div className="max-h-80 overflow-y-auto whitespace-pre-line rounded-xl bg-slate-50 p-4 text-sm leading-relaxed dark:bg-slate-900">
                {selected.content}
              </div>
              {selected.choices.length ? (
                <ul className="grid gap-1 text-sm">
                  {selected.choices.map((c) => (
                    <li key={c.key}>
                      <span className="font-mono text-xs">{c.key}</span> — {c.label}{" "}
                      <span className="text-xs text-slate-500">
                        ({c.kind === "ACKNOWLEDGEMENT" ? "bilgilendirme" : "açık rıza"}
                        {c.required ? ", zorunlu" : ""})
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ) : null}

          <div className="card">
            <h2 className="mb-1 font-semibold">
              {selected ? "Bu şablondan yeni sürüm oluştur" : "Yeni şablon sürümü"}
            </h2>
            <p className="hint mb-4">
              Yeni sürüm taslak olarak kaydedilir; yayımlanana kadar hastalara sunulmaz. İmzalanmış belgeler
              etkilenmez.
            </p>
            <ActionForm
              action={createTemplateVersionAction}
              submitLabel="Yeni sürüm oluştur"
              className="grid gap-4"
            >
              <SelectField
                label="Belge türü"
                name="type"
                options={TYPE_OPTIONS}
                defaultValue={selected?.type ?? "KVKK_DISCLOSURE"}
                idPrefix="tpl"
              />
              <Field
                label="Şablon adı"
                name="name"
                required
                maxLength={200}
                defaultValue={selected?.name ?? ""}
                idPrefix="tpl"
              />
              <div>
                <label htmlFor="tpl-content" className="label">
                  Metin <span aria-hidden="true">*</span>
                </label>
                <textarea
                  id="tpl-content"
                  name="content"
                  required
                  minLength={20}
                  maxLength={50000}
                  rows={12}
                  defaultValue={selected?.content ?? ""}
                  className="input font-mono text-sm"
                />
              </div>
              <div>
                <label htmlFor="tpl-choices" className="label">
                  Seçimler
                </label>
                <textarea
                  id="tpl-choices"
                  name="choices"
                  rows={5}
                  defaultValue={choicesText}
                  aria-describedby="tpl-choices-hint"
                  className="input font-mono text-sm"
                />
                <p id="tpl-choices-hint" className="hint">
                  Her satır: ANAHTAR|Etiket|ACKNOWLEDGEMENT veya CONSENT|zorunlu (evet/hayır). Örn.
                  MARKETING_SMS|SMS ile bilgilendirme|CONSENT|hayır
                </p>
              </div>
            </ActionForm>
          </div>
        </div>
      </div>
    </section>
  );
}
