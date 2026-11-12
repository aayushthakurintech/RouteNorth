import type { Permission } from "@routenorth/shared";
import { BarChart3, Car, CircleDollarSign, KanbanSquare, LayoutDashboard, Map, MapPinned, Rocket, Settings, UserRound, Wallet, type LucideIcon } from "lucide-react";

export interface PortalNavItem { href: string; label: string; icon: LucideIcon; perms: Permission[]; keywords?: string; children?: { href: string; label: string; perms?: Permission[] }[] }

/** The owner's sidebar: ten items, each opens a list first, then a detail page (spec: layout and navigation). */
export const PORTAL_NAV: PortalNavItem[] = [
  { href: "/owner", label: "Dashboard", icon: LayoutDashboard, perms: ["reports.view", "finance.view", "vehicles.manage", "vehicles.assign", "fleet.view"], keywords: "overview money fleet drivers live",
    children: [{ href: "/owner", label: "Overview" }, { href: "/owner?tab=money", label: "Money" }, { href: "/owner?tab=fleet", label: "Fleet" }, { href: "/owner?tab=drivers", label: "Drivers" }, { href: "/owner?tab=live", label: "Live" }] },
  { href: "/live", label: "Live map", icon: Map, perms: ["fleet.view"], keywords: "tracking vehicles map position" },
  { href: "/dispatch", label: "Dispatch", icon: KanbanSquare, perms: ["routes.view"], keywords: "routes jobs stops board assign" },
  { href: "/owner/vehicles", label: "Vehicles", icon: Car, perms: ["fleet.view", "vehicles.manage", "vehicles.assign", "vehicles.costs"], keywords: "cars trucks buses fleet" },
  { href: "/owner/drivers", label: "Drivers", icon: UserRound, perms: ["drivers.view", "drivers.manage"], keywords: "people onboarding license" },
  { href: "/owner/pay-rates", label: "Pay rates", icon: CircleDollarSign, perms: ["pay.view", "pay.manage", "payouts.approve"], keywords: "rate cards bonuses deductions payouts statements" },
  { href: "/owner/trips", label: "Trips", icon: MapPinned, perms: ["reports.view", "pay.view", "fleet.view"], keywords: "jobs replay" },
  { href: "/owner/finance", label: "Finance", icon: Wallet, perms: ["finance.view"], keywords: "earnings expenses invoices profit cash flow budget tax",
    children: [{ href: "/owner/finance", label: "Earnings" }, { href: "/owner/finance/expenses", label: "Expenses" }, { href: "/owner/finance/payouts", label: "Payouts" }, { href: "/owner/finance/invoices", label: "Invoices" }, { href: "/owner/finance/profit-loss", label: "Profit and loss" }, { href: "/owner/finance/cash-flow", label: "Cash flow" }, { href: "/owner/finance/budget", label: "Budget" }, { href: "/owner/finance/tax", label: "Tax summary" }, { href: "/owner/finance/margin", label: "Margin explorer" }] },
  { href: "/owner/reports", label: "Reports", icon: BarChart3, perms: ["reports.view"], keywords: "catalog builder scheduled exports" },
  { href: "/owner/start", label: "Get started", icon: Rocket, perms: ["settings.manage", "fleet.manage", "integrations.manage"], keywords: "start guide setup data trackers import first run" },
  { href: "/owner/settings", label: "Settings", icon: Settings, perms: ["settings.manage", "users.view", "audit.view", "alerts.view"], keywords: "team roles alerts integrations audit log billing",
    children: [{ href: "/owner/settings", label: "Team and roles" }, { href: "/owner/alerts", label: "Alerts inbox", perms: ["alerts.view"] }, { href: "/owner/settings/alerts", label: "Alert settings", perms: ["alerts.manage"] }, { href: "/owner/settings/data-sources", label: "Data sources", perms: ["settings.manage", "fleet.manage", "integrations.manage"] }, { href: "/owner/settings/audit", label: "Audit log", perms: ["audit.view"] }] },
];

export function portalActive(href: string, pathname: string): boolean {
  const base = href.split("?")[0]!;
  if (base === "/owner") return pathname === "/owner";
  return pathname === base || pathname.startsWith(`${base}/`);
}
