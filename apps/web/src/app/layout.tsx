import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "RouteNorth",
  description: "Simple, honest fleet tracking for Canadian trucks and buses",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "RouteNorth", statusBarStyle: "default" },
};

export const viewport: Viewport = { themeColor: "#1e3a8a", viewportFit: "cover" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
