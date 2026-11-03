import type { Permission } from "@routenorth/shared";
import type { MessageKey } from "@routenorth/shared";
import { Activity, FileText, Gauge, History, Map, Route, ScrollText, Settings, Palette, UsersRound, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: MessageKey;
  icon: LucideIcon;
  /** Shown only to people with ANY of these permissions. */
  perms: Permission[];
  group: "main" | "admin";
  /** Extra words the command palette should match. */
  keywords?: string;
}

/** Every page in the sidebar and the command palette. Later features add their pages here. */
export const NAV: NavItem[] = [
  { href: "/", label: "navLive", icon: Map, perms: ["fleet.view"], group: "main", keywords: "map vehicles tracking carte" },
  { href: "/routes", label: "navRoutes", icon: Route, perms: ["routes.view"], group: "main", keywords: "stops plan itinéraires" },
  { href: "/reports", label: "navReports", icon: FileText, perms: ["reports.view"], group: "main", keywords: "distance idle export rapports" },
  { href: "/settings", label: "navSettings", icon: Settings, perms: ["settings.manage"], group: "admin", keywords: "company branding paramètres" },
  { href: "/settings/users", label: "navUsers", icon: UsersRound, perms: ["users.view"], group: "admin", keywords: "people roles permissions users personnes" },
  { href: "/audit", label: "navAudit", icon: ScrollText, perms: ["audit.view"], group: "admin", keywords: "changes history journal" },
  { href: "/styleguide", label: "navStyle", icon: Palette, perms: [], group: "admin", keywords: "design components" },
];

export const ICONS = { Activity, Gauge, History };

/** Pages a person can reach, given their permissions. An empty perms list means everyone. */
export function visibleNav(can: (...p: Permission[]) => boolean): NavItem[] {
  return NAV.filter((n) => n.perms.length === 0 || n.perms.some((p) => can(p)));
}

/** Is `href` the page we are on (or a parent of it)? "/" only matches itself. */
export function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/settings") return pathname === "/settings";
  return pathname === href || pathname.startsWith(`${href}/`);
}
