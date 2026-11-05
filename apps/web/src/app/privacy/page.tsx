import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = { title: "Privacy Notice · RouteNorth", alternates: { canonical: "/privacy" } };

export default function Page() {
  return <LegalPage doc="privacy" />;
}
