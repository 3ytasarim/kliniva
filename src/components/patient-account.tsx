import { ActionForm, Field, SelectField } from "@/components/action-form";
import { EmptyState, Icon, SectionCard } from "@/components/ui";
import { formatDateTime } from "@/components/patient-ui";
import {
  addChargeAction,
  recordPaymentAction,
  voidCashAction,
  voidChargeAction,
} from "@/app/actions/finance";
import { formatMoney, formatMoneyMap, minorToInput } from "@/lib/money";
import { cn } from "@/lib/cn";
import {
  CURRENCIES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type Currency,
  type MoneyByCurrency,
  type PatientAccount,
} from "@/types/finance";

type Service = { id: string; name: string; priceMinor: number | null; currency: string };

/**
 * Hasta hesabı: hizmet bedelleri (borç), tahsilatlar ve bakiye. Hasta dosyasında tüm hesap; randevu sayfasında
 * yalnızca o randevunun kayıtları (appointmentId). Düğmeler yetkiye göre görünür; asıl kontrol sunucuda.
 */
export function PatientAccountPanel({
  account,
  patientId,
  appointmentId,
  services,
  can,
  title = "Hesap",
}: {
  account: PatientAccount;
  patientId: string;
  appointmentId?: string;
  services: Service[];
  can: { charge: boolean; payment: boolean; void: boolean };
  title?: string;
}) {
  const due = account.balance.TRY ?? 0;
  const idp = appointmentId ? `ap-${appointmentId.slice(0, 8)}` : `pt-${patientId.slice(0, 8)}`;
  const hidden = (
    <>
      <input type="hidden" name="patientId" value={patientId} />
      {appointmentId ? <input type="hidden" name="appointmentId" value={appointmentId} /> : null}
    </>
  );

  return (
    <SectionCard
      id="hesap"
      title={title}
      description={
        appointmentId
          ? "Bu randevunun hizmet bedelleri ve tahsilatları. Randevu tamamlanınca hizmet bedeli otomatik eklenir."
          : "Tüm hizmet bedelleri ve tahsilatlar. Kayıtlar silinmez; gerekirse gerekçeyle iptal edilir."
      }
    >
      <dl className="grid gap-3 sm:grid-cols-3">
        <Summary label="Hizmet bedeli" value={account.charged} icon="receipt" />
        <Summary label="Tahsil edilen" value={account.paid} icon="wallet" tone="green" />
        <Summary
          label="Bakiye"
          value={account.balance}
          icon="cash"
          tone={Object.values(account.balance).some((v) => (v ?? 0) > 0) ? "red" : "slate"}
          testId="account-balance"
        />
      </dl>

      {can.charge || can.payment ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {can.payment ? (
            <details className="group rounded-xl border border-line bg-slate-50/60 dark:border-line-dark dark:bg-white/[0.02]">
              <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 text-sm font-semibold">
                <Icon name="wallet" className="size-4 text-emerald-600" /> Tahsilat al
              </summary>
              <ActionForm
                action={recordPaymentAction}
                submitLabel="Tahsilatı kaydet"
                className="grid gap-3 px-4 pb-4 sm:grid-cols-2"
              >
                {hidden}
                <Field
                  label="Tutar"
                  name="amount"
                  required
                  inputMode="decimal"
                  placeholder="örn. 1.250"
                  defaultValue={due > 0 ? minorToInput(due) : ""}
                  idPrefix={`${idp}-pay`}
                />
                <SelectField
                  label="Para birimi"
                  name="currency"
                  defaultValue="TRY"
                  options={CURRENCIES.map((c) => ({ value: c, label: c }))}
                  idPrefix={`${idp}-pay`}
                />
                <SelectField
                  label="Ödeme yöntemi"
                  name="method"
                  required
                  defaultValue="CASH"
                  options={PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))}
                  idPrefix={`${idp}-pay`}
                />
                <Field label="Açıklama" name="description" maxLength={300} idPrefix={`${idp}-pay`} />
              </ActionForm>
            </details>
          ) : null}
          {can.charge ? (
            <details className="group rounded-xl border border-line bg-slate-50/60 dark:border-line-dark dark:bg-white/[0.02]">
              <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 text-sm font-semibold">
                <Icon name="plus" className="size-4 text-brand-600" /> Hizmet bedeli ekle
              </summary>
              <ActionForm
                action={addChargeAction}
                submitLabel="Bedeli ekle"
                className="grid gap-3 px-4 pb-4 sm:grid-cols-2"
              >
                {hidden}
                <SelectField
                  label="Hizmet"
                  name="serviceId"
                  placeholder="— Hizmet seçin (ya da açıklama yazın) —"
                  options={services.map((s) => ({
                    value: s.id,
                    label:
                      s.priceMinor !== null
                        ? `${s.name} · ${formatMoney(s.priceMinor, s.currency as Currency)}`
                        : s.name,
                  }))}
                  className="sm:col-span-2"
                  idPrefix={`${idp}-ch`}
                />
                <Field
                  label="Açıklama"
                  name="description"
                  maxLength={200}
                  hint="Boşsa hizmet adı kullanılır."
                  idPrefix={`${idp}-ch`}
                />
                <Field
                  label="Adet"
                  name="quantity"
                  type="number"
                  min={1}
                  max={1000}
                  defaultValue="1"
                  idPrefix={`${idp}-ch`}
                />
                <Field
                  label="Birim fiyat"
                  name="unitPrice"
                  inputMode="decimal"
                  hint="Boşsa hizmetin liste fiyatı."
                  idPrefix={`${idp}-ch`}
                />
                <Field
                  label="İndirim"
                  name="discount"
                  inputMode="decimal"
                  placeholder="0"
                  idPrefix={`${idp}-ch`}
                />
              </ActionForm>
            </details>
          ) : null}
        </div>
      ) : null}

      <h3 className="mb-2 mt-6 text-sm font-semibold">Hizmet bedelleri</h3>
      {account.charges.length === 0 ? (
        <EmptyState title="Hizmet bedeli yok" icon="receipt" />
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Hizmet</th>
                <th className="text-right">Adet</th>
                <th className="text-right">Tutar</th>
                <th>Durum</th>
                <th>
                  <span className="sr-only">İşlem</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {account.charges.map((c) => (
                <tr key={c.id} className={cn(c.status === "VOIDED" && "opacity-60")}>
                  <td className="whitespace-nowrap">{formatDateTime(c.createdAt)}</td>
                  <td>
                    <span className={cn("font-medium", c.status === "VOIDED" && "line-through")}>
                      {c.description}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {c.source === "APPOINTMENT" ? "Randevudan otomatik" : "Elle eklendi"} ·{" "}
                      {c.createdByName} · {c.branchName}
                      {c.discountMinor ? ` · indirim ${formatMoney(c.discountMinor, c.currency)}` : ""}
                    </span>
                    {c.voidReason ? (
                      <span className="block text-xs text-red-600">İptal: {c.voidReason}</span>
                    ) : null}
                  </td>
                  <td className="text-right tabular-nums">{c.quantity}</td>
                  <td className="text-right font-semibold tabular-nums">
                    {formatMoney(c.totalMinor, c.currency)}
                  </td>
                  <td>
                    {c.status === "ACTIVE" ? (
                      <span className="badge badge-sky">Aktif</span>
                    ) : (
                      <span className="badge badge-gray">İptal</span>
                    )}
                  </td>
                  <td>
                    {can.void && c.status === "ACTIVE" ? (
                      <VoidForm id={c.id} kind="charge" hidden={hidden} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mb-2 mt-6 text-sm font-semibold">Tahsilatlar</h3>
      {account.payments.length === 0 ? (
        <EmptyState title="Tahsilat yok" icon="wallet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Yöntem</th>
                <th className="text-right">Tutar</th>
                <th>Durum</th>
                <th>
                  <span className="sr-only">İşlem</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {account.payments.map((p) => (
                <tr key={p.id} className={cn(p.status === "VOIDED" && "opacity-60")}>
                  <td className="whitespace-nowrap">{formatDateTime(p.occurredAt)}</td>
                  <td>
                    <span className="font-medium">{PAYMENT_METHOD_LABELS[p.method]}</span>
                    <span className="block text-xs text-slate-500">
                      {p.createdByName} · {p.branchName}
                      {p.description ? ` · ${p.description}` : ""}
                    </span>
                    {p.voidReason ? (
                      <span className="block text-xs text-red-600">İptal: {p.voidReason}</span>
                    ) : null}
                  </td>
                  <td
                    className={cn(
                      "text-right font-semibold tabular-nums text-emerald-700 dark:text-emerald-400",
                      p.status === "VOIDED" && "line-through",
                    )}
                  >
                    {formatMoney(p.amountMinor, p.currency)}
                  </td>
                  <td>
                    {p.status === "ACTIVE" ? (
                      <span className="badge badge-green">Alındı</span>
                    ) : (
                      <span className="badge badge-gray">İptal</span>
                    )}
                  </td>
                  <td>
                    {can.void && p.status === "ACTIVE" ? (
                      <VoidForm id={p.id} kind="payment" hidden={hidden} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function Summary({
  label,
  value,
  icon,
  tone = "slate",
  testId,
}: {
  label: string;
  value: MoneyByCurrency;
  icon: "receipt" | "wallet" | "cash";
  tone?: "slate" | "green" | "red";
  testId?: string;
}) {
  return (
    <div className="rounded-xl border border-line p-3 dark:border-line-dark" data-testid={testId}>
      <dt className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
        <Icon name={icon} className="size-3.5" /> {label}
      </dt>
      <dd
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums",
          tone === "green" && "text-emerald-700 dark:text-emerald-400",
          tone === "red" && "text-red-700 dark:text-red-400",
        )}
      >
        {formatMoneyMap(value)}
      </dd>
    </div>
  );
}

function VoidForm({ id, kind, hidden }: { id: string; kind: "charge" | "payment"; hidden: React.ReactNode }) {
  return (
    <details className="relative">
      <summary className="cursor-pointer whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10">
        İptal et
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-72 rounded-xl border border-line bg-white p-3 shadow-raised dark:border-line-dark dark:bg-surface-dark">
        <ActionForm
          action={kind === "charge" ? voidChargeAction : voidCashAction}
          submitLabel="İptali onayla"
          className="grid gap-2"
        >
          <input type="hidden" name="id" value={id} />
          {hidden}
          <Field
            label="İptal gerekçesi"
            name="reason"
            required
            minLength={3}
            maxLength={300}
            hint="Kayıt silinmez; gerekçesiyle iptal görünür. Geri alınamaz."
            idPrefix={`void-${id.slice(0, 8)}`}
          />
        </ActionForm>
      </div>
    </details>
  );
}
