"use client";
import { Activity, Building2, Eye, LogOut, Menu, Moon, ScrollText, ShieldCheck, Sun, UserCog, UsersRound, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LogoMark } from "@/components/Logo";
import { PageTransition, SPRING, motion as fm } from "@/components/motion";
import { Toaster } from "@/components/ui/sonner";
import { ApiError, apiGet, apiSend, Unauthorized } from "@/lib/api";
import type { AdminMe, Catalog } from "@/lib/admin";
import { isStaffRole, loadSession, saveSession } from "@/lib/session";
import { useTheme } from "@/lib/theme-context";
import { CrumbsProvider, useCrumbs } from "@/lib/breadcrumbs";
import { StepUpProvider } from "./StepUp";
import { LoadingState } from "@/components/portal/states";

interface Ctx { me: AdminMe; can: (...p: string[]) => boolean; catalog: Catalog | null; reloadMe: () => void; refreshMe: () => Promise<void> }
const AdminCtx = createContext<Ctx | null>(null);
export function useAdmin(): Ctx {
  const c = useContext(AdminCtx);
  if (!c) throw new Error("useAdmin outside the admin console");
  return c;
}

const NAV: { href: string; label: string; icon: LucideIcon; perm?: string }[] = [
  { href: "/admin", label: "Overview", icon: Activity, perm: "monitor.view" },
  { href: "/admin/clients", label: "Clients", icon: Building2, perm: "clients.view" },
  { href: "/admin/views", label: "Staff views", icon: Eye, perm: "audit.view" },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText, perm: "audit.view" },
  { href: "/admin/staff", label: "Staff accounts", icon: UsersRound, perm: "admins.manage" },
  { href: "/admin/account", label: "My account", icon: UserCog },
];

function Crumbs() {
  const crumbs = useCrumbs();
  if (!crumbs.length) return null;
  return (
    <nav className="crumbs" aria-label="Breadcrumbs">
      {crumbs.map((c, i) => (
        <span key={i} style={{ display: "contents" }}>
          {i > 0 && <span aria-hidden>/</span>}
          {c.href && i < crumbs.length - 1 ? <Link href={c.href}>{c.label}</Link> : <span aria-current={i === crumbs.length - 1 ? "page" : undefined}>{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/** The console's frame. Same look and bones as the product, with an amber rule and an "Admin" tag so it is never confused with a client's view. */
export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { mode, setMode } = useTheme();
  const [me, setMe] = useState<AdminMe | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const s = loadSession();
    if (!s) { router.replace("/login"); return; }
    // A client signed in here belongs in the product, not in the console.
    if (!isStaffRole(s.role)) { router.replace("/live"); return; }
    let live = true;
    apiGet<AdminMe>("/admin/me")
      .then((m) => {
        if (!live) return;
        setMe(m);
        if (m.mustChangePassword && pathname !== "/admin/account") router.replace("/admin/account");
        else void apiGet<Catalog>("/admin/catalog").then((c) => live && setCatalog(c)).catch(() => {});
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof Unauthorized) { saveSession(null); router.replace("/login"); return; }
        setError(e instanceof ApiError && e.status === 403 ? "You do not have access to the console." : "The console could not load. Try again in a moment.");
      });
    return () => { live = false; };
  }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => { if (me?.mustChangePassword && pathname !== "/admin/account") router.replace("/admin/account"); }, [me, pathname, router]);

  const signOut = useCallback(() => { void apiSend("POST", "/admin/logout").catch(() => {}).finally(() => { saveSession(null); router.replace("/login"); }); }, [router]);
  const can = useCallback((...p: string[]) => !!me && p.every((x) => me.perms.includes(x)), [me]);
  const nav = useMemo(() => NAV.filter((n) => !n.perm || can(n.perm)), [can]);
  const ctx = useMemo(() => (me ? { me, can, catalog, reloadMe: () => setTick((n) => n + 1), refreshMe: async () => { setMe(await apiGet<AdminMe>("/admin/me")); } } : null), [me, can, catalog]);

  if (error) return <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}><p role="alert">{error}</p></div>;
  if (!me || !ctx) return <div className="content" style={{ maxWidth: 720, margin: "10vh auto" }}><LoadingState rows={4} /></div>;

  const active = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`));
  return (
    <AdminCtx.Provider value={ctx}>
      <StepUpProvider>
        <div className="app" data-admin data-collapsed={false} data-open={open}>
          <a className="skip-link" href="#main">Skip to content</a>
          <nav className="sidenav" aria-label="Admin navigation">
            <Link href="/admin" className="brand"><LogoMark size={30} /><span className="brand-name">RouteNorth</span></Link>
            <div className="nav-group">
              {nav.map((n) => (
                <Link key={n.href} href={n.href} className="nav-item" aria-current={active(n.href) ? "page" : undefined}>
                  {active(n.href) && <fm.span layoutId="admin-nav-active" className="nav-active" transition={SPRING} />}
                  <n.icon size={18} aria-hidden /><span className="nav-text">{n.label}</span>
                </Link>
              ))}
            </div>
            <div className="nav-spacer" />
            <div className="nav-item" style={{ cursor: "default", alignItems: "flex-start", flexDirection: "column", gap: 2, height: "auto", padding: "8px 10px" }}>
              <span className="nav-text" style={{ fontWeight: 600, color: "var(--nav-fg-strong)" }}>{me.displayName ?? me.email}</span>
              <span className="nav-text" style={{ fontSize: 12, color: "var(--nav-muted)", display: "inline-flex", gap: 6, alignItems: "center" }}><ShieldCheck size={13} aria-hidden />{me.roleLabel}</span>
            </div>
          </nav>
          <div className="nav-scrim" onClick={() => setOpen(false)} aria-hidden />
          <header className="topbar">
            <button type="button" className="icon-btn menu-btn" aria-label="Open menu" onClick={() => setOpen(true)}><Menu size={20} /></button>
            <Crumbs />
            <div className="top-actions">
              <button type="button" className="icon-btn" aria-label={mode === "dark" ? "Switch to light" : "Switch to dark"} onClick={() => setMode(mode === "dark" ? "light" : "dark")}>{mode === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
              <button type="button" className="icon-btn" aria-label="Sign out" title="Sign out" onClick={signOut}><LogOut size={18} /></button>
            </div>
          </header>
          <main id="main" className="main" tabIndex={-1}>
            <PageTransition id={pathname}><div className="portal-root owner-page">{children}</div></PageTransition>
          </main>
        </div>
        <Toaster richColors closeButton position="bottom-right" />
      </StepUpProvider>
    </AdminCtx.Provider>
  );
}

export function AdminLayout({ children }: { children: ReactNode }) {
  return <CrumbsProvider><AdminShell>{children}</AdminShell></CrumbsProvider>;
}
