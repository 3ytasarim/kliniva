import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import "./globals.css";

// Inter: derleme anında indirilir ve KENDİ sunucumuzdan verilir (CSP font-src 'self'; çalışma anında Google'a istek yok).
const inter = Inter({ subsets: ["latin", "latin-ext"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: { default: "Kliniva AI", template: "%s · Kliniva AI" },
  description: "Kliniva AI — klinikler için çok kiracılı randevu, muayene ve CRM platformu.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#f6f7f9",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Nonce tabanlı CSP her istekte yeni nonce gerektirir → tüm sayfalar dinamik render edilir (statik HTML nonce taşıyamaz).
  await connection();
  // Tema: varsayılan açık; "dark" seçildiyse koyu cam görünüm (Tailwind dark: varyantı bu özniteliğe bağlı).
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="tr" className={inter.variable} data-theme={theme}>
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow-raised dark:focus:bg-slate-900"
        >
          İçeriğe geç
        </a>
        {children}
      </body>
    </html>
  );
}
