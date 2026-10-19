/** Platform giriş adımları: sade, ortalanmış kart (klinik menüsü yok). */
export default function PlatformAuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="eyebrow">Kliniva</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Platform yönetimi</h1>
        </div>
        {children}
      </div>
    </main>
  );
}
