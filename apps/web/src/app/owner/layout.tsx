"use client";
import type { ReactNode } from "react";
import { OwnerShell } from "@/components/portal/OwnerShell";
import { CrumbsProvider } from "@/lib/breadcrumbs";
import { MeProvider } from "@/lib/me-context";

/** Every Owner Portal page lives under this layout. */
export default function OwnerLayout({ children }: { children: ReactNode }) {
  return (
    <MeProvider>
      <CrumbsProvider>
        <OwnerShell>{children}</OwnerShell>
      </CrumbsProvider>
    </MeProvider>
  );
}
