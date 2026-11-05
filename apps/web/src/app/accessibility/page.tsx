import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = { title: "Accessibility Statement · RouteNorth", alternates: { canonical: "/accessibility" } };

export default function Page() {
  return <LegalPage doc="accessibility" />;
}
