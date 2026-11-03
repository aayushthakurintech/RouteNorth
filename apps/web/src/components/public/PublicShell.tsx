"use client";
import { useEffect, type ReactNode } from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useTheme } from "@/lib/theme-context";

export interface PublicOrg { name: string; color: string | null; logo: string | null }

/** The frame for pages customers open without signing in: the company's name and colour, a language switch and room for content. */
export function PublicShell({ org, children, wide }: { org: PublicOrg | null; children: ReactNode; wide?: boolean }) {
  const { setBrand } = useTheme();
  const color = org?.color && /^#[0-9a-f]{6}$/i.test(org.color) ? org.color : null;
  // The theme lightens or darkens the company's colour until text on it is readable in light, dark and high-contrast modes.
  useEffect(() => { setBrand(color); return () => setBrand(null); }, [color, setBrand]);
  return (
    <main className="track pub">
      <header className="track-head">
        {org?.logo ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={org.logo} alt="" height={28} /> : null}
        <strong>{org?.name ?? "RouteNorth"}</strong>
        <span style={{ flex: 1 }} />
        <LanguageToggle />
      </header>
      <div className={`pub-body${wide ? " wide" : ""}`}>{children}</div>
    </main>
  );
}
