import type { Metadata } from "next";
import { Landing } from "@/components/landing/Landing";

export const metadata: Metadata = {
  title: "RouteNorth: fleet tracking for Canadian trucks and buses",
  description: "Live vehicle tracking, idling and fuel reports, and hours-of-service clocks for Canadian fleets. English and French. Start a 30-day free trial.",
  openGraph: {
    title: "RouteNorth: fleet tracking for Canadian trucks and buses",
    description: "Every truck and bus on one honest map. Idling, fuel and hours-of-service clocks with the working shown.",
    type: "website", locale: "en_CA", siteName: "RouteNorth",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "RouteNorth: every truck and bus on one honest map" }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"],
  },
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return <Landing />;
}
