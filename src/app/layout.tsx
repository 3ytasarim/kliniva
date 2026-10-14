import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Kliniva AI", template: "%s · Kliniva AI" },
  description: "Kliniva AI — klinikler için çok kiracılı klinik operasyon ve CRM platformu.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Nonce tabanlı CSP her istekte yeni nonce gerektirir → tüm sayfalar dinamik render edilir (statik HTML nonce taşıyamaz).
  await connection();
  return (
    <html lang="tr">
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm"
        >
          İçeriğe geç
        </a>
        {children}
      </body>
    </html>
  );
}
