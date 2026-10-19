import Link from "next/link";
import { LogOut } from "lucide-react";
import { requirePlatform } from "@/server/platform/guards";
import { platformLogoutAction } from "@/app/actions/platform";

/** Platform konsolu kabuğu (yalnızca ACTIVE platform oturumu). Klinik uygulamasından bağımsız. */
export default async function PlatformConsoleLayout({ children }: { children: React.ReactNode }) {
  const p = await requirePlatform();
  return (
    <div className="min-h-dvh">
      <header className="app-topbar sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-line bg-white/80 px-4 backdrop-blur-md md:px-8 dark:border-line-dark">
        <Link href="/platform" className="flex items-center gap-2 font-semibold tracking-tight">
          {/* eslint-disable-next-line @next/next/no-img-element -- statik marka görseli */}
          <img src="/brand/kliniva-mark.png" alt="" width={28} height={28} className="size-7" />
          Kliniva Platform
        </Link>
        <nav aria-label="Platform menüsü" className="flex gap-1 text-sm">
          <Link
            href="/platform"
            className="rounded-lg px-3 py-2 font-medium hover:bg-slate-100 dark:hover:bg-white/5"
          >
            Klinikler
          </Link>
          <Link
            href="/platform/clinics/new"
            className="rounded-lg px-3 py-2 font-medium hover:bg-slate-100 dark:hover:bg-white/5"
          >
            Yeni klinik
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="hidden text-slate-500 sm:inline">{p.displayName}</span>
          <form action={platformLogoutAction}>
            <button type="submit" className="btn-icon" aria-label="Çıkış yap" title="Çıkış yap">
              <LogOut className="size-[18px]" aria-hidden="true" />
            </button>
          </form>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
        {children}
      </main>
    </div>
  );
}
