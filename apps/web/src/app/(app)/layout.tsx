"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { CrumbsProvider } from "@/lib/breadcrumbs";
import { MeProvider } from "@/lib/me-context";

/** Every signed-in page lives under this layout: sidebar, top bar, search, onboarding. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <MeProvider>
      <CrumbsProvider>
        <AppShell flush={pathname === "/"}>{children}</AppShell>
      </CrumbsProvider>
    </MeProvider>
  );
}
