"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { apiGet } from "@/lib/api";
import { useMe } from "@/lib/me-context";
import { PORTAL_NAV } from "@/lib/portal/nav";

interface Hit { type: string; id: string; title: string; subtitle: string | null }
const hitHref = (h: Hit) => h.type === "vehicle" ? `/owner/vehicles/${h.id}` : h.type === "driver" ? `/owner/drivers/${h.id}` : h.type === "route" ? `/routes/${h.id}` : "/routes";

/** Search and jump anywhere with Ctrl or Cmd + K (spec: command palette). */
export function CommandMenu({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const router = useRouter();
  const { can } = useMe();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen(!open); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    let live = true;
    const t = setTimeout(() => { apiGet<Hit[]>(`/search?q=${encodeURIComponent(q.trim())}`).then((h) => { if (live) setHits(h); }).catch(() => { if (live) setHits([]); }); }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const go = (href: string) => { setOpen(false); setQ(""); router.push(href); };
  const items = PORTAL_NAV.filter((n) => n.perms.some((p) => can(p)));
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Search pages, vehicles and drivers">
      <CommandInput placeholder="Search vehicles, drivers, pages…" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>Nothing found.</CommandEmpty>
        {hits.length > 0 && (
          <>
            <CommandGroup heading="Results">
              {hits.map((h) => <CommandItem key={`${h.type}-${h.id}`} value={`${h.title} ${h.subtitle ?? ""} ${h.id}`} onSelect={() => go(hitHref(h))}>{h.title}<span className="ml-auto text-xs text-muted-foreground">{h.type}{h.subtitle ? ` · ${h.subtitle}` : ""}</span></CommandItem>)}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}
        <CommandGroup heading="Go to">
          {items.flatMap((n) => [{ href: n.href, label: n.label, kw: n.keywords }, ...(n.children ?? []).filter((c) => c.href !== n.href).map((c) => ({ href: c.href, label: `${n.label}: ${c.label}`, kw: n.keywords }))]).map((n) => (
            <CommandItem key={n.href} value={`${n.label} ${n.kw ?? ""}`} onSelect={() => go(n.href)}>{n.label}</CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Other">
          <CommandItem value="live map" onSelect={() => go("/live")}>Live map (full screen)</CommandItem>
          <CommandItem value="dispatch board" onSelect={() => go("/dispatch")}>Dispatch board</CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
