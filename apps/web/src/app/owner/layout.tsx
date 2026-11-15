"use client";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { DateRangePicker } from "@/components/portal/DateRangePicker";
import { RangeProvider } from "@/components/portal/range-context";
import { Toaster } from "@/components/ui/sonner";
import { CrumbsProvider } from "@/lib/breadcrumbs";
import { MeProvider } from "@/lib/me-context";

/** Owner Portal pages share the one app frame (sidebar, top bar, search); this adds the date range and the portal's base styles. */
export default function OwnerLayout({ children }: { children: ReactNode }) {
  return (
    <MeProvider>
      <CrumbsProvider>
        <RangeProvider>
          <AppShell topSlot={<div className="portal-root top-range"><DateRangePicker /></div>}>
            <div className="portal-root owner-page">{children}</div>
            <Toaster richColors closeButton position="bottom-right" />
          </AppShell>
        </RangeProvider>
      </CrumbsProvider>
    </MeProvider>
  );
}
