"use client";

/** Hata sınırı: kullanıcıya ayrıntı (stack, veri) gösterilmez. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-lg font-semibold">Bir şeyler ters gitti</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        İşlem tamamlanamadı. Lütfen tekrar deneyin.
      </p>
      <button type="button" className="btn mt-6" onClick={reset}>
        Tekrar dene
      </button>
    </main>
  );
}
