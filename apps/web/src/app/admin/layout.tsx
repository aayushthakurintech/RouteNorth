"use client";
import type { ReactNode } from "react";
import { AdminLayout } from "@/components/admin/AdminShell";

/** Everything under /admin is the console, for RouteNorth staff. A client who lands here is sent back to the product. */
export default function Layout({ children }: { children: ReactNode }) {
  return <AdminLayout>{children}</AdminLayout>;
}
