export default function InventoryLoading() {
  return (
    <div role="status" aria-live="polite" className="grid gap-4">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />
      <div className="h-20 animate-pulse rounded-2xl bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="h-12 animate-pulse rounded-xl bg-slate-100 motion-reduce:animate-none dark:bg-slate-900"
        />
      ))}
      <span className="sr-only">Stok yükleniyor…</span>
    </div>
  );
}
