export function Forbidden() {
  return (
    <div role="alert" className="card">
      <h1 className="font-semibold">Yetkiniz yok</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Bu sayfayı görüntüleme yetkiniz bulunmuyor.
      </p>
    </div>
  );
}
