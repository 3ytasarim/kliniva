import { requireUser } from "@/server/auth/guards";

/**
 * Odak düzeni (tablet imza ekranı): kenar menü YOK — hasta tabletteyken uygulamanın geri kalanına gezinemez.
 * Oturum zorunlu; yetki kontrolleri sayfa + serviste ayrıca yapılır.
 */
export default async function FocusLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return (
    <main id="main" className="mx-auto min-h-dvh w-full max-w-4xl px-4 py-6 md:px-8">
      {children}
    </main>
  );
}
