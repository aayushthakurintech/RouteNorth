"use client";
import { Bell, ChevronsUpDown, LogOut, Monitor, Moon, Search, Sun, Building2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, SidebarRail, SidebarTrigger } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { Separator } from "@/components/ui/separator";
import { apiSend } from "@/lib/api";
import { useMe } from "@/lib/me-context";
import { PORTAL_NAV, portalActive } from "@/lib/portal/nav";
import { loadSession, saveSession } from "@/lib/session";
import { useTheme } from "@/lib/theme-context";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";
import { CommandMenu } from "./CommandMenu";
import { DateRangePicker } from "./DateRangePicker";
import { RangeProvider } from "./range-context";
import { useCrumbs } from "@/lib/breadcrumbs";
import { Breadcrumbs } from "./parts";
import { ErrorState } from "./states";

/** The Owner Portal frame: collapsible left sidebar, top bar (search, date range, company, alerts, profile), bottom bar on phones. */
export function OwnerShell({ children }: { children: ReactNode }) {
  const { me, loading, error, can } = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const { mode, setMode } = useTheme();
  const crumbs = useCrumbs();
  const [palette, setPalette] = useState(false);
  useEffect(() => { if (!loading && !loadSession()) router.replace("/login"); }, [loading, router]);
  const nav = PORTAL_NAV.filter((n) => n.perms.some((p) => can(p)));
  const alerts = useApi<{ open: number; critical: number }>(me && can("alerts.view") ? "/alerts/summary" : null, { intervalMs: 60_000 });
  const signOut = () => { void apiSend("POST", "/auth/logout").catch(() => {}).finally(() => { saveSession(null); router.replace("/login"); }); };

  if (loading || (!me && !error)) {
    return <div className="portal-root p-6"><Skeleton className="mb-4 h-8 w-64" /><Skeleton className="h-64 w-full" /></div>;
  }
  if (error || !me) return <div className="portal-root p-6"><ErrorState error={error ?? new Error("Could not load your account")} /></div>;
  if (nav.length === 0) return <div className="portal-root p-6"><ErrorState error={new Error("Your role does not have access to the owner portal.")} /></div>;

  return (
    <RangeProvider>
      <SidebarProvider className="portal-root min-h-svh bg-background text-foreground">
        <Sidebar collapsible="icon" className="hidden md:flex">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" asChild>
                  <Link href="/owner">
                    <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">R</div>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-semibold">{me.org.brandName ?? "RouteNorth"}</span>
                      <span className="truncate text-xs text-muted-foreground">Owner portal</span>
                    </div>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {nav.map((n) => {
                    const active = portalActive(n.href, pathname);
                    return (
                      <SidebarMenuItem key={n.href}>
                        <SidebarMenuButton asChild isActive={active} tooltip={n.label}>
                          <Link href={n.href}><n.icon /><span>{n.label}</span></Link>
                        </SidebarMenuButton>
                        {active && n.children && n.children.length > 0 && (
                          <SidebarMenuSub>
                            {n.children.filter((c) => !c.perms || c.perms.some((p) => can(p))).map((c) => {
                              const base = c.href.split("?")[0]!;
                              const here = base === pathname && (c.href.includes("?") ? false : true);
                              return <SidebarMenuSubItem key={c.href}><SidebarMenuSubButton asChild isActive={here}><Link href={c.href}>{c.label}</Link></SidebarMenuSubButton></SidebarMenuSubItem>;
                            })}
                          </SidebarMenuSub>
                        )}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem><SidebarMenuButton asChild tooltip="Back to the live map and dispatch"><Link href="/"><Search /><span>Live map and dispatch</span></Link></SidebarMenuButton></SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>

        <SidebarInset className="min-w-0 pb-16 md:pb-0">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70">
            <SidebarTrigger className="hidden md:inline-flex" aria-label="Collapse sidebar" />
            <Separator orientation="vertical" className="mr-1 hidden h-5 md:block" />
            <Button variant="outline" size="sm" className="w-full max-w-xs justify-start gap-2 text-muted-foreground" onClick={() => setPalette(true)} aria-label="Search (Ctrl K)">
              <Search className="size-4" /> <span className="truncate">Search…</span>
              <kbd className="ml-auto hidden rounded border bg-muted px-1.5 text-[10px] font-medium sm:inline">Ctrl K</kbd>
            </Button>
            <div className="ml-auto flex items-center gap-1.5">
              <DateRangePicker />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="hidden gap-1 lg:inline-flex"><Building2 className="size-4" /><span className="max-w-32 truncate">{me.org.name}</span><ChevronsUpDown className="size-3 opacity-60" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Company</DropdownMenuLabel>
                  <DropdownMenuItem disabled>{me.org.name} · {me.org.settings.currency}</DropdownMenuItem>
                  <DropdownMenuItem disabled className="text-xs">Switching between several companies is not built yet.</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="ghost" size="icon" asChild aria-label={`Alerts${alerts.data?.open ? `, ${alerts.data.open} open` : ""}`} className="relative">
                <Link href="/owner/settings/alerts"><Bell className="size-4" />{!!alerts.data?.open && <Badge variant={alerts.data.critical ? "destructive" : "secondary"} className="absolute -right-1 -top-1 h-4 min-w-4 justify-center px-1 text-[10px]">{alerts.data.open}</Badge>}</Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Theme">{mode === "dark" ? <Moon className="size-4" /> : mode === "light" ? <Sun className="size-4" /> : <Monitor className="size-4" />}</Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setMode("light")}><Sun /> Light</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setMode("dark")}><Moon /> Dark</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setMode("auto")}><Monitor /> Auto</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="rounded-full" aria-label="Profile"><span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{(me.user.displayName ?? me.user.email).slice(0, 1).toUpperCase()}</span></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="font-normal"><div className="text-sm font-medium">{me.user.displayName ?? me.user.email}</div><div className="text-xs text-muted-foreground">{me.user.email} · {me.user.customRoleName ?? me.user.role}</div></DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild><Link href="/settings/security">Security and sessions</Link></DropdownMenuItem>
                  <DropdownMenuItem asChild><Link href="/settings/profile">Profile</Link></DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={signOut}><LogOut /> Sign out</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 p-4 md:p-6"><Breadcrumbs items={crumbs} />{children}</main>
        </SidebarInset>

        {/* Phone: the sidebar becomes a bottom bar. */}
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background md:hidden">
          {nav.slice(0, 5).map((n) => (
            <Link key={n.href} href={n.href} aria-current={portalActive(n.href, pathname) ? "page" : undefined} className={cn("flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]", portalActive(n.href, pathname) ? "text-primary" : "text-muted-foreground")}>
              <n.icon className="size-5" />{n.label}
            </Link>
          ))}
          {nav.length > 5 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] text-muted-foreground"><ChevronsUpDown className="size-5" />More</button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top">{nav.slice(5).map((n) => <DropdownMenuItem key={n.href} asChild><Link href={n.href}><n.icon /> {n.label}</Link></DropdownMenuItem>)}</DropdownMenuContent>
            </DropdownMenu>
          )}
        </nav>
        <CommandMenu open={palette} setOpen={setPalette} />
        <Toaster richColors closeButton position="bottom-right" />
      </SidebarProvider>
    </RangeProvider>
  );
}
