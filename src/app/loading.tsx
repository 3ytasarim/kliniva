export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="p-8">
      <div className="h-4 w-40 animate-pulse rounded bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />
      <span className="sr-only">Yükleniyor…</span>
    </div>
  );
}
