"use client";
import { useEffect, useState, type ReactNode } from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useI18n } from "@/lib/i18n-context";
import { useTheme } from "@/lib/theme-context";
import { frameAllowed, parentOrigin } from "@/lib/widget";

export interface PublicOrg { name: string; color: string | null; logo: string | null; /** false: show the small "Powered by" line. Left out where the company has not been loaded. */ whiteLabel?: boolean; widgetOrigins?: string }

/** The frame for pages customers open without signing in: the company's name and colour, a language switch and room for content. */
export function PublicShell({ org, children, wide }: { org: PublicOrg | null; children: ReactNode; wide?: boolean }) {
  const { setBrand } = useTheme();
  const { t } = useI18n();
  const [embed, setEmbed] = useState(false);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const e = new URLSearchParams(location.search).has("embed") && window.self !== window.top;
    setEmbed(e);
    setBlocked(e && !!org && !frameAllowed(parentOrigin(), org.widgetOrigins ?? ""));
  }, [org]);
  const color = org?.color && /^#[0-9a-f]{6}$/i.test(org.color) ? org.color : null;
  // The theme lightens or darkens the company's colour until text on it is readable in light, dark and high-contrast modes.
  useEffect(() => { setBrand(color); return () => setBrand(null); }, [color, setBrand]);
  return (
    <main className={`track pub${embed ? " embed" : ""}`}>
      <header className="track-head">
        {org?.logo ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={org.logo} alt="" height={28} /> : null}
        <strong>{org?.name ?? "RouteNorth"}</strong>
        <span style={{ flex: 1 }} />
        <LanguageToggle />
      </header>
      <div className={`pub-body${wide ? " wide" : ""}`}>{blocked ? <p role="alert">{t("pub_notAllowedHere")}</p> : children}</div>
      {!embed && org?.whiteLabel === false && <footer className="meta small" style={{ textAlign: "center", padding: "var(--s4)" }}>{t("pub_poweredBy")}</footer>}
    </main>
  );
}
