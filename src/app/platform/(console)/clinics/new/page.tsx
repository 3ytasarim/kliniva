import type { Metadata } from "next";
import { requirePlatform } from "@/server/platform/guards";
import { createClinicAction } from "@/app/actions/platform";
import { ActionForm, Field } from "@/components/action-form";
import { PageHeader, SectionCard } from "@/components/ui";

export const metadata: Metadata = { title: "Yeni klinik · Platform" };

/**
 * Yeni klinik: klinik kodu rastgele üretilir; "Merkez" şubesi, klinik profili ve klinik sahibi hesabı açılır.
 * Verilen parola geçicidir — yönetici ilk girişte değiştirmek zorundadır. Doktor / resepsiyon / odaları klinik
 * yöneticisi kendisi oluşturur.
 */
export default async function NewClinicPage() {
  await requirePlatform();
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader
        title="Yeni klinik"
        description="Klinik kodu otomatik ve rastgele oluşturulur. Yönetici ilk girişte parolasını değiştirir."
        back={{ href: "/platform", label: "Klinikler" }}
      />
      <ActionForm action={createClinicAction} submitLabel="Kliniği oluştur" className="grid gap-6">
        <SectionCard title="Klinik">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Klinik adı"
              name="name"
              required
              maxLength={120}
              placeholder="örn. Moda Dermatoloji"
              idPrefix="nc"
            />
            <Field
              label="Şehir"
              name="city"
              required
              maxLength={80}
              placeholder="örn. İstanbul"
              idPrefix="nc"
            />
          </div>
        </SectionCard>
        <SectionCard
          title="Klinik yöneticisi"
          description="Kliniğin sahibi / yöneticisi. Doktorları, resepsiyonu ve odaları bu hesapla oluşturur."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Ad" name="ownerFirstName" required maxLength={80} idPrefix="nc" />
            <Field label="Soyad" name="ownerLastName" required maxLength={80} idPrefix="nc" />
            <Field
              label="Kullanıcı adı"
              name="ownerUsername"
              maxLength={40}
              autoCapitalize="none"
              spellCheck={false}
              placeholder="örn. moda.yonetici"
              hint="Küçük harf, rakam, nokta, alt çizgi, tire. E-posta ya da kullanıcı adından biri zorunlu."
              idPrefix="nc"
            />
            <Field label="E-posta (isteğe bağlı)" name="ownerEmail" type="email" idPrefix="nc" />
            <Field
              label="Geçici parola"
              name="ownerPassword"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              hint="En az 12 karakter, harf ve rakam. Yönetici ilk girişte değiştirir."
              idPrefix="nc"
              className="sm:col-span-2"
            />
          </div>
        </SectionCard>
      </ActionForm>
    </section>
  );
}
