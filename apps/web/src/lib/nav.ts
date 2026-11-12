import type { Permission } from "@routenorth/shared";
import type { MessageKey } from "@routenorth/shared";
import {
  Activity, AlertTriangle, Antenna, HeartPulse, LifeBuoy, Lock, Sparkles, Scale, ShieldCheck, MessageSquareHeart, BarChart3, Banknote, Clock, Inbox, Receipt, Workflow, CheckSquare, LayoutDashboard, BellRing, ClipboardCheck, ClipboardList, Container, FileText, Fuel, Gauge, Hexagon, History, IdCard, KanbanSquare, Map, MapPinned, Palette, Repeat, Route,
  Plug, SlidersHorizontal, Upload, ScrollText, Settings, Truck, UsersRound, Warehouse, Wrench, CalendarDays, ListChecks, Wallet, Users, type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: MessageKey;
  icon: LucideIcon;
  /** Shown only to people with ANY of these permissions. */
  perms: Permission[];
  group: "main" | "fleet" | "admin";
  /** A small count shown beside the name (loaded by the shell). */
  badge?: "approvals" | "inbox";
  /** Extra words the command palette should match. */
  keywords?: string;
}

/** Every page in the sidebar and the command palette. Later features add their pages here. */
export const NAV: NavItem[] = [
  { href: "/owner", label: "navOwnerPortal", icon: Wallet, perms: ["reports.view", "finance.view"], group: "main", keywords: "owner dashboard money vehicles drivers pay finance reports alerts start data sources propriétaire tableau finances" },
  { href: "/live", label: "navLive", icon: Map, perms: ["fleet.view"], group: "main", keywords: "map vehicles tracking carte" },
  { href: "/routes", label: "navRoutes", icon: Route, perms: ["routes.view"], group: "main", keywords: "stops plan itinéraires" },
  { href: "/dispatch", label: "navDispatch", icon: KanbanSquare, perms: ["routes.view"], group: "main", keywords: "board assign drivers répartition tableau" },
  { href: "/jobs", label: "navJobs", icon: ClipboardList, perms: ["routes.view"], group: "main", keywords: "orders deliveries pickups tâches commandes" },
  { href: "/analytics", label: "navAnalytics", icon: LayoutDashboard, perms: ["reports.view", "driver.app"], group: "main", keywords: "dashboard kpi goals insights tableau de bord indicateurs" },
  { href: "/analytics/reports", label: "navReportBuilder", icon: BarChart3, perms: ["reports.view"], group: "main", keywords: "report builder charts pivot export scheduled constructeur de rapports" },
  { href: "/alerts", label: "navAlerts", icon: BellRing, perms: ["alerts.view"], group: "main", keywords: "alerts rules notifications slack teams alertes règles" },
  { href: "/inbox", label: "navInbox", icon: Inbox, perms: ["routes.dispatch", "customers.manage"], group: "main", badge: "inbox", keywords: "messages chat drivers customers help messagerie clients aide" },
  { href: "/approvals", label: "navApprovals", icon: CheckSquare, perms: ["reports.view"], group: "main", badge: "approvals", keywords: "approve overtime expenses approbations" },
  { href: "/automation", label: "navAutomation", icon: Workflow, perms: ["alerts.view"], group: "main", keywords: "workflows rules webhooks no-code if then automatisation flux" },
  { href: "/assistant", label: "navAssistant", icon: Sparkles, perms: ["routes.view"], group: "main", keywords: "ai briefing ask predict forecast assistant assistant intelligent prévisions" },
  { href: "/optimize", label: "navOptimize", icon: Scale, perms: ["routes.view"], group: "main", keywords: "areas territories balance depots cost co2 simulate what-if zones équilibre simulation" },
  { href: "/safety", label: "navSafety", icon: ShieldCheck, perms: ["reports.view"], group: "main", keywords: "safety score coaching rewards fatigue sos check-in dash cam sécurité récompenses" },
  { href: "/reports", label: "navReports", icon: FileText, perms: ["reports.view"], group: "main", keywords: "distance idle export rapports" },
  { href: "/fleet/vehicles", label: "navFleetVehicles", icon: Truck, perms: ["fleet.view", "routes.view"], group: "fleet", keywords: "trucks buses vans camions autobus" },
  { href: "/drivers", label: "navDrivers", icon: IdCard, perms: ["users.view", "routes.view"], group: "fleet", keywords: "licence license skills chauffeurs" },
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
  { href: "/timesheets", label: "navTimesheets", icon: Clock, perms: ["reports.view"], group: "fleet", keywords: "shifts hours overtime pay feuilles de temps quarts heures" },
  { href: "/expenses", label: "navExpenses", icon: Receipt, perms: ["reports.view"], group: "fleet", keywords: "receipts reimburse dépenses reçus" },
  { href: "/tasks", label: "navTasks", icon: ListChecks, perms: ["routes.view"], group: "main", keywords: "to-do todo dispatcher reminders tâches à faire rappels" },
  { href: "/schedule", label: "navSchedule", icon: CalendarDays, perms: ["routes.view"], group: "fleet", keywords: "shifts time off vacation calendar planning quarts congés horaire" },
  { href: "/billing", label: "navBilling", icon: Wallet, perms: ["reports.view", "customers.view", "settings.manage", "billing.manage"], group: "admin", keywords: "plan trial quotes rate cards budget contracts payroll profit tax devis tarifs budgets contrats paie profit taxes forfait" },
  { href: "/invoices", label: "navInvoices", icon: Banknote, perms: ["customers.view"], group: "admin", keywords: "billing pdf factures facturation" },
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

/** Is `href` the page we are on (or a parent of it)? "/" only matches itself. */
export function isActive(href: string, pathname: string): boolean {
  if (href === "/live") return pathname === "/live";
  if (href === "/settings") return pathname === "/settings";
  if (href === "/analytics") return pathname === "/analytics" || pathname.startsWith("/analytics/goals");
  if (href === "/jobs") return pathname === "/jobs" || pathname.startsWith("/jobs/");
  return pathname === href || pathname.startsWith(`${href}/`);
}
