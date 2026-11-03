import "@fontsource-variable/inter";
import "@fontsource-variable/manrope";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n-context";
import { THEME_BOOT_SCRIPT, ThemeProvider } from "@/lib/theme-context";
import { ToastProvider } from "@/lib/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "RouteNorth",
  description: "Simple, honest fleet tracking for Canadian trucks and buses",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "RouteNorth", statusBarStyle: "default" },
};

export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#0f5fa8" }, { media: "(prefers-color-scheme: dark)", color: "#0b1019" }], viewportFit: "cover" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <I18nProvider>
          <ThemeProvider>
            <ToastProvider>{children}</ToastProvider>
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
