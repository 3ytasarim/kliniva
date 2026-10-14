import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-lg font-semibold">Sayfa bulunamadı</h1>
      <Link href="/dashboard" className="btn-ghost mt-6">
        Panele dön
      </Link>
    </main>
  );
}
