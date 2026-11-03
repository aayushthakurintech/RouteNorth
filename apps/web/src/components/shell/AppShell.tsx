"use client";
import { Notifications } from "./Notifications";
import {
  Sparkles, ChevronsLeft, ChevronsRight, Keyboard, LogOut, Menu, Monitor, Moon, Pin, PinOff, Search, Sun, Contrast, UserRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LOCALES, LOCALE_NAMES, type Locale, type MessageKey } from "@routenorth/shared";
import { ErrorState, SkeletonList } from "@/components/ui/primitives";
import { useCrumbs } from "@/lib/breadcrumbs";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useApi } from "@/lib/use-api";
import { isActive, visibleNav } from "@/lib/nav";
import { loadSession, saveSession } from "@/lib/session";
import { useTheme, type MotionMode, type ThemeMode } from "@/lib/theme-context";
import { RELEASE_NOTES } from "@/lib/whats-new";
import { CommandPalette, type Command } from "./CommandPalette";
import { ProductTour, SetupChecklist, ShortcutsSheet, WhatsNew } from "./Onboarding";

const THEMES: { mode: ThemeMode; key: "themeLight" | "themeDark" | "themeAuto" | "themeContrast"; icon: ReactNode }[] = [
  { mode: "light", key: "themeLight", icon: <Sun size={16} /> }, { mode: "dark", key: "themeDark", icon: <Moon size={16} /> },
  { mode: "auto", key: "themeAuto", icon: <Monitor size={16} /> }, { mode: "contrast", key: "themeContrast", icon: <Contrast size={16} /> },
];

/** Sidebar, top bar, command palette, shortcuts, onboarding. Wraps every signed-in page. */
export function AppShell({ children, flush }: { children: ReactNode; flush?: boolean }) {
  const { t, locale, setLocale } = useI18n();
  const { me, loading, error, can, prefs, setPrefs, reload } = useMe();
  const { mode, setMode, motion, setMotion } = useTheme();
  const pathname = usePathname();
  const router = useRouter();
  const crumbs = useCrumbs();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [news, setNews] = useState(false);
  const [tour, setTour] = useState(false);
  const [menu, setMenu] = useState(false);
  const collapsed = !!prefs.navCollapsed;
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!loading && !loadSession()) router.replace("/login"); }, [loading, router]);
  useEffect(() => { setOpen(false); }, [pathname]);
  // Drivers and customers have their own apps.
  useEffect(() => { if (me && me.home !== "/" && pathname === "/") router.replace(me.home); }, [me, pathname, router]);
  useEffect(() => {
    if (pathname === "/" && me && !(prefs.onboarding?.steps ?? []).includes("map") && can("settings.manage")) {
      setPrefs({ onboarding: { ...prefs.onboarding, steps: [...(prefs.onboarding?.steps ?? []), "map"] } });
    }
  }, [pathname, me]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (me && can("settings.manage") && !prefs.onboarding?.tourDone && !prefs.onboarding?.hidden) setTour(true);
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [menu]);

  const signOut = useCallback(() => { saveSession(null); router.replace("/login"); }, [router]);
  const nav = useMemo(() => visibleNav(can), [can]);
  const approvals = useApi<{ pending: number }>(can("reports.view") ? "/approvals/count" : null, { intervalMs: 60_000 });
  const inbox = useApi<{ drivers: number; customers: number; help: number }>(can("routes.dispatch") || can("customers.manage") ? "/messages/unread" : null, { intervalMs: 30_000 });
  const badges = { approvals: approvals.data?.pending ?? 0, inbox: (inbox.data?.drivers ?? 0) + (inbox.data?.customers ?? 0) + (inbox.data?.help ?? 0) };
  const go = useCallback((href: string, label?: string) => {
    if (label) setPrefs({ recent: [{ href, label }, ...(prefs.recent ?? []).filter((r) => r.href !== href)].slice(0, 5) });
    router.push(href);
  }, [router, prefs.recent, setPrefs]);
  const cycleTheme = useCallback(() => {
    const order: ThemeMode[] = ["light", "dark", "contrast", "auto"];
    setMode(order[(order.indexOf(mode) + 1) % order.length]!);
  }, [mode, setMode]);

  // Keyboard shortcuts (ignored while typing in a field)
  const chord = useRef<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(true); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); setPalette(true); return; }
      if (e.key === "?") { setHelp(true); return; }
      if (e.key === "[") { setPrefs({ navCollapsed: !collapsed }); return; }
      if (e.key === "t") { cycleTheme(); return; }
      if (chord.current === "g") {
        chord.current = null;
        const dest: Record<string, string> = { l: "/", r: "/routes", p: "/reports" };
        const href = dest[e.key];
        if (href) go(href);
        return;
      }
      if (e.key === "g") { chord.current = "g"; setTimeout(() => { chord.current = null; }, 900); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, cycleTheme, go, setPrefs]);

  const brandName = me?.org.brandName || "RouteNorth";
  const favorites = prefs.favorites ?? [];
  const pinned = favorites.some((f) => f.href === pathname);
  const pageLabel = crumbs.at(-1)?.label ?? (nav.find((n) => isActive(n.href, pathname)) ? t(nav.find((n) => isActive(n.href, pathname))!.label) : "");
  const unread = RELEASE_NOTES[0] && prefs.whatsNewSeen !== RELEASE_NOTES[0].id;

  const commands: Command[] = useMemo(() => {
    const pages: Command[] = nav.map((n) => ({ id: `page:${n.href}`, label: t(n.label), group: "jumpTo", keywords: n.keywords, icon: <n.icon size={16} aria-hidden />, run: () => go(n.href, t(n.label)) }));
    const actions: Command[] = [
      { id: "act:theme", label: `${t("theme")}: ${t("themeDark")} / ${t("themeLight")}`, group: "actions", keywords: "dark light mode sombre clair theme", icon: <Moon size={16} />, run: cycleTheme },
      { id: "act:nav", label: collapsed ? t("expandNav") : t("collapseNav"), group: "actions", icon: <ChevronsLeft size={16} />, run: () => setPrefs({ navCollapsed: !collapsed }) },
      { id: "act:keys", label: t("shortcuts"), group: "actions", keywords: "help aide raccourcis ?", icon: <Keyboard size={16} />, run: () => setHelp(true) },
      { id: "act:news", label: t("whatsNew"), group: "actions", icon: <Sparkles size={16} />, run: () => setNews(true) },
      { id: "act:tour", label: t("setupTour"), group: "actions", icon: <UserRound size={16} />, run: () => setTour(true) },
      ...LOCALES.filter((l) => l !== locale).map((l): Command => ({ id: `act:lang:${l}`, label: `${t("language")}: ${LOCALE_NAMES[l]}`, group: "actions", keywords: "language langue", run: () => setLocale(l) })),
      { id: "act:signout", label: t("signOut"), group: "actions", icon: <LogOut size={16} />, run: signOut },
    ];
    const favs: Command[] = favorites.map((f) => ({ id: `fav:${f.href}`, label: f.label, group: "favorites", icon: <Pin size={16} />, run: () => go(f.href) }));
    return [...favs, ...pages, ...actions];
  }, [nav, t, go, cycleTheme, collapsed, setPrefs, favorites, locale, setLocale, signOut]);

  if (loading) {
    return <div className="content" style={{ maxWidth: 720, margin: "10vh auto" }}><SkeletonList rows={4} h={48} /></div>;
  }
  if (error || !me) {
    return <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}><ErrorState error={error} onRetry={reload} /></div>;
  }

  const sections = [
    { id: "main", label: null as MessageKey | null, items: nav.filter((n) => n.group === "main") },
    { id: "fleet", label: "navFleet" as MessageKey, items: nav.filter((n) => n.group === "fleet") },
    { id: "admin", label: "settings" as MessageKey, items: nav.filter((n) => n.group === "admin") },
  ];

  return (
    <div className="app" data-collapsed={collapsed} data-open={open}>
      <a className="skip-link" href="#main">{t("skipToContent")}</a>
      <nav className="sidenav" aria-label={t("mainNav")}>
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden>
            {me.org.logoDataUrl ? <img src={me.org.logoDataUrl} alt="" /> : <svg width="18" height="18" viewBox="0 0 18 18"><path d="M4 15V3l10 12V3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </span>
          <span className="brand-name">{brandName}</span>
        </Link>
        {favorites.length > 0 && (
          <div className="nav-group">
            <span className="nav-label">{t("favorites")}</span>
            {favorites.map((f) => (
              <Link key={f.href} href={f.href} className="nav-item" aria-current={pathname === f.href ? "page" : undefined} title={f.label}><Pin size={18} aria-hidden /><span className="nav-text">{f.label}</span></Link>
            ))}
          </div>
        )}
        {sections.map((s) => s.items.length > 0 && (
          <div className="nav-group" key={s.id}>
            {s.label && <span className="nav-label">{t(s.label)}</span>}
            {s.items.map((n) => (
              <Link key={n.href} href={n.href} className="nav-item" aria-current={isActive(n.href, pathname) ? "page" : undefined} title={collapsed ? t(n.label) : undefined}>
                <n.icon size={18} aria-hidden /><span className="nav-text">{t(n.label)}</span>
                {n.badge && badges[n.badge] > 0 && <span className="nav-badge" aria-label={t("navBadge", { n: badges[n.badge] })}>{badges[n.badge] > 99 ? "99+" : badges[n.badge]}</span>}
              </Link>
            ))}
          </div>
        ))}
        <div className="nav-spacer" />
        <SetupChecklist onTour={() => setTour(true)} />
        <button type="button" className="nav-item" onClick={() => setPrefs({ navCollapsed: !collapsed })} aria-label={collapsed ? t("expandNav") : t("collapseNav")}>
          {collapsed ? <ChevronsRight size={18} aria-hidden /> : <ChevronsLeft size={18} aria-hidden />}<span className="nav-text">{collapsed ? t("expandNav") : t("collapseNav")}</span>
        </button>
      </nav>
      <div className="nav-scrim" onClick={() => setOpen(false)} aria-hidden />

      <header className="topbar">
        <button type="button" className="icon-btn menu-btn" aria-label={t("openMenu")} onClick={() => setOpen(true)}><Menu size={20} /></button>
        <nav className="crumbs" aria-label={t("breadcrumbs")}>
          {crumbs.length > 0 ? crumbs.map((c, i) => (
            <span key={i} style={{ display: "contents" }}>
              {i > 0 && <span aria-hidden>/</span>}
              {c.href && i < crumbs.length - 1 ? <Link href={c.href}>{c.label}</Link> : <span aria-current={i === crumbs.length - 1 ? "page" : undefined}>{c.label}</span>}
            </span>
          )) : pageLabel ? <span aria-current="page">{pageLabel}</span> : null}
        </nav>
        <div className="top-actions">
          <button type="button" className="search-trigger" onClick={() => setPalette(true)}>
            <Search size={16} aria-hidden /><span className="label">{t("search")}</span><span className="kbd">Ctrl K</span>
          </button>
          {pageLabel && (
            <button
              type="button" className="icon-btn" aria-pressed={pinned} aria-label={pinned ? t("unpinThis") : t("pinThis")} title={pinned ? t("unpinThis") : t("pinThis")}
              onClick={() => setPrefs({ favorites: pinned ? favorites.filter((f) => f.href !== pathname) : [...favorites, { href: pathname, label: pageLabel }].slice(-8) })}
            >{pinned ? <PinOff size={18} /> : <Pin size={18} />}</button>
          )}
          <Notifications />
          <button type="button" className="icon-btn" aria-label={t("whatsNew")} title={t("whatsNew")} onClick={() => setNews(true)} style={{ position: "relative" }}>
            <Sparkles size={18} />{unread && <span aria-label="•" style={{ position: "absolute", top: 6, insetInlineEnd: 7, width: 8, height: 8, borderRadius: "50%", background: "var(--danger)" }} />}
          </button>
          <div className="rel" ref={menuRef}>
            <button type="button" className="icon-btn" aria-label={t("accountMenu")} aria-expanded={menu} onClick={() => setMenu((v) => !v)}><UserRound size={20} /></button>
            {menu && (
              <div className="menu" role="menu">
                <div className="menu-label">{t("signedInAs", { name: me.user.displayName ?? me.user.email })}</div>
                <div style={{ padding: "0 12px 4px" }}><span className="chip brand">{me.user.customRoleName ?? t(`role_${me.user.role}` as never)}</span></div>
                <div className="menu-sep" />
                <div className="menu-label">{t("theme")}</div>
                <div className="seg" role="group" aria-label={t("theme")} style={{ margin: "0 8px" }}>
                  {THEMES.map((th) => <button key={th.mode} type="button" aria-pressed={mode === th.mode} title={t(th.key)} aria-label={t(th.key)} onClick={() => setMode(th.mode)}>{th.icon}</button>)}
                </div>
                <div className="menu-label">{t("motion")}</div>
                <div className="seg" role="group" aria-label={t("motion")} style={{ margin: "0 8px" }}>
                  {(["auto", "reduce", "full"] as MotionMode[]).map((m) => (
                    <button key={m} type="button" aria-pressed={motion === m} onClick={() => setMotion(m)}>{t(m === "auto" ? "motionAuto" : m === "reduce" ? "motionReduced" : "motionFull")}</button>
                  ))}
                </div>
                <div className="menu-label">{t("language")}</div>
                <select aria-label={t("language")} value={locale} style={{ margin: "0 8px" }} onChange={(e) => setLocale(e.target.value as Locale)}>
                  {LOCALES.map((l) => <option key={l} value={l} lang={l}>{LOCALE_NAMES[l]}</option>)}
                </select>
                <div className="menu-sep" />
                <Link className="menu-item" href="/settings/profile" role="menuitem" onClick={() => setMenu(false)}><UserRound size={16} />{t("profile")}</Link>
                <button type="button" className="menu-item" role="menuitem" onClick={() => { setMenu(false); setHelp(true); }}><Keyboard size={16} />{t("shortcuts")}</button>
                <button type="button" className="menu-item" role="menuitem" onClick={signOut}><LogOut size={16} />{t("signOut")}</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main id="main" className={`main ${flush ? "flush" : ""}`} tabIndex={-1}>{children}</main>

      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} onNavigate={go} />
      <ShortcutsSheet open={help} onClose={() => setHelp(false)} />
      <WhatsNew open={news} onClose={() => setNews(false)} />
      <ProductTour open={tour} onClose={() => setTour(false)} />
    </div>
  );
}
