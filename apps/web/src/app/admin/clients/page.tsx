"use client";
import { Loader2, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useAdmin } from "@/components/admin/AdminShell";
import { useStepUp } from "@/components/admin/StepUp";
import { Field, HealthPill, OneTimeDialog, Secret, fail, selectCls } from "@/components/admin/parts";
import { PageHeader } from "@/components/portal/parts";
import { EmptyState, ErrorState, LoadingState } from "@/components/portal/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/portal/parts";
import { ago, type ClientRow } from "@/lib/admin";
import { apiSend } from "@/lib/api";
import { useApi } from "@/lib/use-api";

export default function ClientsPage() {
  const { can, catalog } = useAdmin();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [status, setStatus] = useState("");
  const [health, setHealth] = useState("");
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const params = new URLSearchParams();
  if (dq) params.set("q", dq);
  if (status) params.set("status", status);
  if (health) params.set("health", health);
  const list = useApi<ClientRow[]>(can("clients.view") ? `/admin/clients?${params}` : null);
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<{ url: string; id: string } | null>(null);

  if (!can("clients.view")) return <ErrorState error="HTTP 403" />;
  return (
    <>
      <PageHeader title="Clients" description="Every company that uses RouteNorth. Open one to change what it can use, look at how it is doing, or suspend it."
        crumbs={[{ label: "Clients" }]}
        actions={can("clients.create") ? <Button onClick={() => setCreating(true)}><Plus /> New client</Button> : undefined} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label="Search clients" placeholder="Search by name, short name or owner email" className="ps-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select aria-label="Status" className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option><option value="active">Active</option><option value="suspended">Suspended</option></select>
        <select aria-label="Health" className={selectCls} value={health} onChange={(e) => setHealth(e.target.value)}><option value="">Any health</option><option value="bad">Needs attention</option><option value="warn">Needs a look</option><option value="ok">Healthy</option></select>
      </div>
      {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <LoadingState rows={6} /> : list.data.length === 0 ? (
        <EmptyState title={dq || status || health ? "No client matches" : "No clients yet"}>{dq || status || health ? "Try clearing a filter." : "Create the first client and send its owner the setup link."}</EmptyState>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader><TableRow><TableHead>Client</TableHead><TableHead>Health</TableHead><TableHead>Plan</TableHead><TableHead>Sections</TableHead><TableHead className="text-end">Vehicles</TableHead><TableHead className="text-end">Trackers live</TableHead><TableHead>Last sign-in</TableHead></TableRow></TableHeader>
            <TableBody>
              {list.data.map((c) => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => router.push(`/admin/clients/${c.id}`)}>
                  <TableCell><Link href={`/admin/clients/${c.id}`} className="font-medium underline-offset-4 hover:underline" onClick={(e) => e.stopPropagation()}>{c.name}</Link><div className="text-xs text-muted-foreground">{c.ownerEmail ?? "no owner"}</div></TableCell>
                  <TableCell><HealthPill level={c.health.level} /></TableCell>
                  <TableCell><span className="capitalize">{c.plan}</span></TableCell>
                  <TableCell>{c.entitlements.restricted ? <StatusBadge tone="warn">{c.entitlements.sections.length} of {catalog?.sections.length ?? 10}</StatusBadge> : <span className="text-muted-foreground">All</span>}</TableCell>
                  <TableCell className="text-end tabular-nums">{c.usage.vehicles}</TableCell>
                  <TableCell className="text-end tabular-nums">{c.usage.devicesLive}/{c.usage.devices}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{ago(c.usage.lastLoginAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <NewClient open={creating} onClose={() => setCreating(false)} onCreated={(x) => { setCreating(false); setLink(x); list.reload(); }} />
      <OneTimeDialog open={!!link} onClose={() => { const id = link?.id; setLink(null); if (id) router.push(`/admin/clients/${id}`); }} title="Client created" description="No email is sent from here. Pass this link to the owner so they can choose a password. It works for 7 days and is shown only now.">
        {link && <Secret label="Setup link" value={link.url} />}
      </OneTimeDialog>
    </>
  );
}

function NewClient({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (x: { url: string; id: string }) => void }) {
  const { catalog } = useAdmin();
  const withStepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: "", ownerName: "", ownerEmail: "", plan: "trial", preset: "full", locale: "en" });
  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    try {
      const r = await withStepUp(() => apiSend<{ id: string; setupLink: string }>("POST", "/admin/clients", { ...f }));
      toast.success(`${f.name} created`);
      setF({ name: "", ownerName: "", ownerEmail: "", plan: "trial", preset: "full", locale: "en" });
      onCreated({ url: r.setupLink, id: r.id });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>New client</DialogTitle><DialogDescription>Creates the company and its first owner. You can change the sections later.</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Company name"><Input required minLength={2} maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Owner's name"><Input required maxLength={80} value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></Field>
            <Field label="Owner's email"><Input required type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Plan"><select className={`${selectCls} w-full`} value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>{(catalog?.plans ?? [{ id: "trial" }]).map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}</select></Field>
            <Field label="Sections"><select className={`${selectCls} w-full`} value={f.preset} onChange={(e) => setF({ ...f, preset: e.target.value })}>{(catalog?.presets ?? [{ id: "full", label: "Everything" }]).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
            <Field label="Language"><select className={`${selectCls} w-full`} value={f.locale} onChange={(e) => setF({ ...f, locale: e.target.value })}><option value="en">English</option><option value="fr">Français</option></select></Field>
          </div>
          <Button type="submit" className="w-full" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Create client</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
