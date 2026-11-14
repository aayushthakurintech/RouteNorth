import type { Permission } from "@routenorth/shared";
import type { MessageKey } from "@routenorth/shared";
import {
  Activity, AlertTriangle, Antenna, HeartPulse, LifeBuoy, Lock, Sparkles, Scale, ShieldCheck, MessageSquareHeart, BarChart3, Banknote, Clock, Inbox, Receipt, Workflow, CheckSquare, LayoutDashboard, BellRing, ClipboardCheck, ClipboardList, Container, FileText, Fuel, Gauge, Hexagon, History, IdCard, KanbanSquare, Map, MapPinned, Palette, Repeat, Route,
  Plug, Cable, CircleDollarSign, Rocket, SlidersHorizontal, Upload, ScrollText, Settings, Truck, UsersRound, Warehouse, Wrench, CalendarDays, ListChecks, Wallet, Users, type LucideIcon,
} from "lucide-react";

export type NavGroup = "overview" | "operate" | "fleet" | "money" | "reports" | "admin";

export interface NavItem {
  href: string;
  /** A translated label. Pages added with the Owner Portal use plain `text` until they are translated. */
  label?: MessageKey;
  text?: string;
  icon: LucideIcon;
  /** Shown only to people with ANY of these permissions. */
  perms: Permission[];
  group: NavGroup;
  /** A small count shown beside the name (loaded by the shell). */
  badge?: "approvals" | "inbox";
  /** Extra words the command palette should match. */
  keywords?: string;
}

/** Every page in the sidebar and the command palette. Later features add their pages here. */
export const NAV: NavItem[] = [
  { href: "/owner", label: "navOwnerPortal", icon: Wallet, perms: ["reports.view", "finance.view"], group: "overview", keywords: "owner dashboard money vehicles drivers pay finance reports alerts start data sources propriétaire tableau finances" },
  { href: "/live", label: "navLive", icon: Map, perms: ["fleet.view"], group: "overview", keywords: "map vehicles tracking carte" },
  { href: "/routes", label: "navRoutes", icon: Route, perms: ["routes.view"], group: "operate", keywords: "stops plan itinéraires" },
  { href: "/dispatch", label: "navDispatch", icon: KanbanSquare, perms: ["routes.view"], group: "operate", keywords: "board assign drivers répartition tableau" },
  { href: "/jobs", label: "navJobs", icon: ClipboardList, perms: ["routes.view"], group: "operate", keywords: "orders deliveries pickups tâches commandes" },
  { href: "/analytics", label: "navAnalytics", icon: LayoutDashboard, perms: ["reports.view", "driver.app"], group: "overview", keywords: "dashboard kpi goals insights tableau de bord indicateurs" },
  { href: "/analytics/reports", label: "navReportBuilder", icon: BarChart3, perms: ["reports.view"], group: "reports", keywords: "report builder charts pivot export scheduled constructeur de rapports" },
  { href: "/alerts", label: "navAlerts", icon: BellRing, perms: ["alerts.view"], group: "overview", keywords: "alerts rules notifications slack teams alertes règles" },
  { href: "/inbox", label: "navInbox", icon: Inbox, perms: ["routes.dispatch", "customers.manage"], group: "operate", badge: "inbox", keywords: "messages chat drivers customers help messagerie clients aide" },
  { href: "/approvals", label: "navApprovals", icon: CheckSquare, perms: ["reports.view"], group: "operate", badge: "approvals", keywords: "approve overtime expenses approbations" },
  { href: "/automation", label: "navAutomation", icon: Workflow, perms: ["alerts.view"], group: "operate", keywords: "workflows rules webhooks no-code if then automatisation flux" },
  { href: "/assistant", label: "navAssistant", icon: Sparkles, perms: ["routes.view"], group: "operate", keywords: "ai briefing ask predict forecast assistant assistant intelligent prévisions" },
  { href: "/optimize", label: "navOptimize", icon: Scale, perms: ["routes.view"], group: "operate", keywords: "areas territories balance depots cost co2 simulate what-if zones équilibre simulation" },
  { href: "/safety", label: "navSafety", icon: ShieldCheck, perms: ["reports.view"], group: "fleet", keywords: "safety score coaching rewards fatigue sos check-in dash cam sécurité récompenses" },
  { href: "/reports", label: "navReports", icon: FileText, perms: ["reports.view"], group: "reports", keywords: "distance idle export rapports" },
  { href: "/owner/vehicles", text: "Vehicles", icon: Truck, perms: ["fleet.view", "vehicles.manage", "vehicles.assign", "vehicles.costs"], group: "fleet", keywords: "trucks buses vans cars fleet add vehicle camions autobus" },
  { href: "/owner/connections", text: "Connections", icon: Cable, perms: ["fleet.view", "fleet.manage", "vehicles.manage"], group: "fleet", keywords: "tracker gps imei connect provider geotab samsara traccar device id first ping" },
  { href: "/owner/drivers", text: "Drivers", icon: IdCard, perms: ["drivers.view", "drivers.manage"], group: "fleet", keywords: "people onboarding license licence chauffeurs" },
  { href: "/owner/pay-rates", text: "Pay rates", icon: CircleDollarSign, perms: ["pay.view", "pay.manage", "payouts.approve"], group: "money", keywords: "rate cards bonuses deductions payouts statements" },
  { href: "/owner/finance", text: "Finance", icon: Wallet, perms: ["finance.view"], group: "money", keywords: "earnings expenses invoices profit cash flow budget tax" },
  { href: "/owner/trips", text: "Trips", icon: MapPinned, perms: ["reports.view", "pay.view", "fleet.view"], group: "operate", keywords: "jobs replay" },
  { href: "/owner/reports", text: "Reports", icon: BarChart3, perms: ["reports.view"], group: "reports", keywords: "catalog builder scheduled exports" },
  { href: "/owner/start", text: "Get started", icon: Rocket, perms: ["settings.manage", "fleet.manage", "integrations.manage"], group: "overview", keywords: "start guide setup data trackers import first run" },
  { href: "/care", label: "navFleetCare", icon: Wrench, perms: ["fleet.view", "routes.view"], group: "fleet", keywords: "maintenance service documents expiry reminders entretien rappels" },
  { href: "/fuel", label: "navFuel", icon: Fuel, perms: ["fleet.view", "reports.view"], group: "fleet", keywords: "gas diesel litres carburant" },
  { href: "/trips", label: "navTripLog", icon: MapPinned, perms: ["fleet.view", "reports.view"], group: "fleet", keywords: "mileage tax business personal kilométrage" },
  { href: "/geofences", label: "navGeofences", icon: Hexagon, perms: ["fleet.view", "alerts.view"], group: "fleet", keywords: "zones alerts enter exit géoclôtures" },
  { href: "/devices", label: "navDevices", icon: Antenna, perms: ["fleet.view"], group: "fleet", keywords: "gps trackers imei devices health battery traceurs appareils" },
  { href: "/fleet/inspections", label: "navInspections", icon: ClipboardCheck, perms: ["fleet.view", "routes.view"], group: "fleet", keywords: "checklist check-in check-out defects" },
  { href: "/fleet/incidents", label: "navIncidents", icon: AlertTriangle, perms: ["fleet.view", "routes.view"], group: "fleet", keywords: "accident report photos" },
  { href: "/fleet/equipment", label: "navEquipment", icon: Container, perms: ["fleet.view", "routes.view"], group: "fleet", keywords: "trailers remorques" },
  { href: "/fleet/depots", label: "navDepots", icon: Warehouse, perms: ["fleet.view", "routes.view"], group: "fleet", keywords: "parking yard dépôts" },
  { href: "/fleet/route-templates", label: "navTemplates", icon: Repeat, perms: ["routes.view"], group: "fleet", keywords: "recurring repeat modèles" },
  { href: "/timesheets", label: "navTimesheets", icon: Clock, perms: ["reports.view"], group: "money", keywords: "shifts hours overtime pay feuilles de temps quarts heures" },
  { href: "/expenses", label: "navExpenses", icon: Receipt, perms: ["reports.view"], group: "money", keywords: "receipts reimburse dépenses reçus" },
  { href: "/tasks", label: "navTasks", icon: ListChecks, perms: ["routes.view"], group: "operate", keywords: "to-do todo dispatcher reminders tâches à faire rappels" },
  { href: "/schedule", label: "navSchedule", icon: CalendarDays, perms: ["routes.view"], group: "operate", keywords: "shifts time off vacation calendar planning quarts congés horaire" },
  { href: "/billing", label: "navBilling", icon: Wallet, perms: ["reports.view", "customers.view", "settings.manage", "billing.manage"], group: "money", keywords: "plan trial quotes rate cards budget contracts payroll profit tax devis tarifs budgets contrats paie profit taxes forfait" },
  { href: "/invoices", label: "navInvoices", icon: Banknote, perms: ["customers.view"], group: "money", keywords: "billing pdf factures facturation" },
  { href: "/settings", label: "navSettings", icon: Settings, perms: ["settings.manage"], group: "admin", keywords: "company branding paramètres" },
  { href: "/settings/customers", label: "navCustomerSettings", icon: MessageSquareHeart, perms: ["settings.manage"], group: "admin", keywords: "customer notifications booking portal status faq clients messages réservation" },
  { href: "/settings/teams", label: "navTeams", icon: Users, perms: ["users.view", "fleet.view", "routes.view"], group: "admin", keywords: "regions depots groups invite activity équipes régions invitations activité" },
  { href: "/settings/users", label: "navUsers", icon: UsersRound, perms: ["users.view"], group: "admin", keywords: "people roles permissions users personnes" },
  { href: "/integrations", label: "navIntegrations", icon: Plug, perms: ["api.manage", "integrations.manage"], group: "admin", keywords: "api keys webhooks zapier make feeds sheets calendar email widget maps intégrations clés" },
  { href: "/settings/fields", label: "navFields", icon: SlidersHorizontal, perms: ["settings.manage"], group: "admin", keywords: "custom fields statuses labels champs personnalisés statuts" },
  { href: "/import", label: "navImport", icon: Upload, perms: ["routes.write"], group: "admin", keywords: "import csv onfleet routific migrate spreadsheet importer migration" },
  { href: "/settings/security", label: "navSecurity", icon: Lock, perms: [], group: "admin", keywords: "two-factor 2fa password sessions privacy export delete compliance sécurité authentification confidentialité" },
  { href: "/settings/health", label: "navHealth", icon: HeartPulse, perms: ["settings.manage"], group: "admin", keywords: "status errors usage analytics flags labs santé erreurs utilisation" },
  { href: "/support", label: "navSupport", icon: LifeBuoy, perms: [], group: "admin", keywords: "help support feedback roadmap contact aide assistance commentaires" },
  { href: "/audit", label: "navAudit", icon: ScrollText, perms: ["audit.view"], group: "admin", keywords: "changes history journal" },
  { href: "/styleguide", label: "navStyle", icon: Palette, perms: [], group: "admin", keywords: "design components" },
];

export const ICONS = { Activity, Gauge, History, BellRing };

/** Pages a person can reach, given their permissions. An empty perms list means everyone. */
export function visibleNav(can: (...p: Permission[]) => boolean): NavItem[] {
  return NAV.filter((n) => n.perms.length === 0 || n.perms.some((p) => can(p)));
}

/** The words shown for a page: its translation when it has one, otherwise its plain text. */
export const navText = (n: NavItem, t: (k: MessageKey) => string): string => (n.label ? t(n.label) : n.text ?? n.href);

/** Is `href` the page we are on (or a parent of it)? "/" only matches itself. */
export function isActive(href: string, pathname: string): boolean {
  if (href === "/owner") return pathname === "/owner";
  if (href === "/live") return pathname === "/live";
  if (href === "/settings") return pathname === "/settings";
  if (href === "/analytics") return pathname === "/analytics" || pathname.startsWith("/analytics/goals");
  if (href === "/jobs") return pathname === "/jobs" || pathname.startsWith("/jobs/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Section headings in the sidebar, in order. `overview` has no heading. */
export const NAV_SECTIONS: { id: NavGroup; label: string | null }[] = [
  { id: "overview", label: null }, { id: "operate", label: "Operate" }, { id: "fleet", label: "Fleet" }, { id: "money", label: "Money" }, { id: "reports", label: "Reports" }, { id: "admin", label: "Settings" },
];

/** What comes first inside a section; anything not listed follows in file order. */
const FIRST = ["/owner", "/live", "/owner/start", "/analytics", "/alerts", "/dispatch", "/routes", "/jobs", "/owner/trips", "/owner/vehicles", "/owner/connections", "/owner/drivers", "/devices", "/owner/finance", "/owner/pay-rates", "/billing", "/owner/reports", "/analytics/reports", "/settings"];
export function sectionItems(items: NavItem[], group: NavGroup): NavItem[] {
  const rank = (h: string) => { const i = FIRST.indexOf(h); return i < 0 ? FIRST.length : i; };
  return items.map((n, i) => ({ n, i })).filter(({ n }) => n.group === group).sort((a, b) => rank(a.n.href) - rank(b.n.href) || a.i - b.i).map(({ n }) => n);
}
