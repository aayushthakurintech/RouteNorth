"use client";
import { Loader2, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useAdmin } from "@/components/admin/AdminShell";
import { useStepUp } from "@/components/admin/StepUp";
import { Field, OneTimeDialog, Secret, fail, selectCls } from "@/components/admin/parts";
import { ConfirmDialog, PageHeader, StatusBadge } from "@/components/portal/parts";
import { ErrorState, LoadingState } from "@/components/portal/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ago, type SetupPackage, type StaffRow } from "@/lib/admin";
import { apiSend } from "@/lib/api";
import { useApi } from "@/lib/use-api";

/** Staff accounts: only a super admin gets here. The last active super admin can never be removed. */
export default function StaffPage() {
  const { can, me, catalog } = useAdmin();
  const withStepUp = useStepUp();
  const q = useApi<StaffRow[]>(can("admins.manage") ? "/admin/admins" : null);
  const [creating, setCreating] = useState(false);
  const [pkg, setPkg] = useState<{ title: string; email: string; p: SetupPackage } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "reset" | "disable" | "enable"; row: StaffRow } | null>(null);
  if (!can("admins.manage")) return <ErrorState error="HTTP 403" />;
  const roleLabel = (id: string) => catalog?.roles.find((r) => r.id === id)?.label ?? id;

  async function run(label: string, fn: () => Promise<unknown>) {
    try { await withStepUp(fn); toast.success(label); q.reload(); return true; } catch (e) { fail(e); return false; }
  }
  async function changeRole(row: StaffRow, role: string) { await run(`${row.email} is now ${roleLabel(role)}. They sign in again.`, () => apiSend("PATCH", `/admin/admins/${row.id}`, { role })); }
  async function doConfirm() {
    if (!confirm) return;
    const { kind, row } = confirm; setConfirm(null);
    if (kind === "reset") {
      try { const r = await withStepUp(() => apiSend<{ setup: SetupPackage }>("POST", `/admin/admins/${row.id}/reset-credentials`)); setPkg({ title: "Credentials reset", email: row.email, p: r.setup }); q.reload(); } catch (e) { fail(e); }
    } else await run(kind === "disable" ? `${row.email} disabled` : `${row.email} enabled`, () => apiSend("PATCH", `/admin/admins/${row.id}`, { disabled: kind === "disable" }));
  }
  return (
    <>
      <PageHeader title="Staff accounts" description="People at RouteNorth who can use this console. Everyone needs an authenticator app; there is no way to turn that off." crumbs={[{ label: "Staff accounts" }]}
        actions={<Button onClick={() => setCreating(true)}><Plus /> New staff account</Button>} />
      {q.error && !q.data ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <LoadingState /> : (
        <div className="rounded-xl border"><Table>
          <TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Role</TableHead><TableHead>Last sign-in</TableHead><TableHead>State</TableHead><TableHead className="text-end">Actions</TableHead></TableRow></TableHeader>
          <TableBody>{q.data.map((s) => {
            const self = s.id === me.id;
            return (
              <TableRow key={s.id}>
                <TableCell><div className="font-medium">{s.displayName ?? s.email}{self ? " (you)" : ""}</div><div className="text-xs text-muted-foreground">{s.email}{s.ipAllowList.length ? ` · only from ${s.ipAllowList.join(", ")}` : ""}</div></TableCell>
                <TableCell>{self ? roleLabel(s.role) : <select aria-label={`Role for ${s.email}`} className={selectCls} value={s.role} onChange={(e) => void changeRole(s, e.target.value)}>{(catalog?.roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{ago(s.lastLoginAt)}</TableCell>
                <TableCell className="space-x-1">{s.disabled ? <StatusBadge>Disabled</StatusBadge> : s.locked ? <StatusBadge tone="bad">Locked</StatusBadge> : s.mustChangePassword ? <StatusBadge tone="warn">Setup pending</StatusBadge> : <StatusBadge tone="good">Active</StatusBadge>}{s.activeSessions > 0 && <span className="text-xs text-muted-foreground">online</span>}</TableCell>
                <TableCell className="space-x-1 text-end whitespace-nowrap">
                  {s.locked && <Button size="xs" variant="outline" onClick={() => void run("Unlocked", () => apiSend("POST", `/admin/admins/${s.id}/unlock`))}>Unlock</Button>}
                  <Button size="xs" variant="outline" onClick={() => setConfirm({ kind: "reset", row: s })}>Reset credentials</Button>
                  {!self && <Button size="xs" variant={s.disabled ? "outline" : "destructive"} onClick={() => setConfirm({ kind: s.disabled ? "enable" : "disable", row: s })}>{s.disabled ? "Enable" : "Disable"}</Button>}
                </TableCell>
              </TableRow>
            );
          })}</TableBody>
        </Table></div>
      )}
      <NewStaff open={creating} onClose={() => setCreating(false)} onCreated={(email, p) => { setCreating(false); setPkg({ title: "Staff account created", email, p }); q.reload(); }} />
      <ConfirmDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)} destructive={confirm?.kind !== "enable"}
        title={confirm?.kind === "reset" ? `Reset credentials for ${confirm.row.email}?` : confirm?.kind === "disable" ? `Disable ${confirm?.row.email}?` : `Enable ${confirm?.row.email}?`}
        description={confirm?.kind === "reset" ? "Gives them a new temporary password and a new authenticator secret, and signs them out everywhere. Use it when a phone is lost." : confirm?.kind === "disable" ? "They are signed out now and cannot sign in until you enable the account again." : "They can sign in again."}
        confirmLabel={confirm?.kind === "reset" ? "Reset" : confirm?.kind === "disable" ? "Disable" : "Enable"} onConfirm={() => void doConfirm()} />
      <OneTimeDialog open={!!pkg} onClose={() => setPkg(null)} title={pkg?.title ?? ""} description={`Give this to ${pkg?.email ?? "them"} over a safe channel, not by email. It is shown only now. They set their own password at first sign-in.`}>
        {pkg && (<>
          <Secret label="Temporary password" value={pkg.p.temporaryPassword} />
          <Secret label="Authenticator secret (type it into the app, or open the link on their phone)" value={pkg.p.totpSecret} />
          <Secret label="Authenticator link" value={pkg.p.otpauth} />
          <div className="space-y-1"><p className="text-xs font-medium text-muted-foreground">Recovery codes (each works once; keep them somewhere safe)</p><p className="rounded-md border bg-muted p-2.5 font-mono text-sm leading-6 select-all">{pkg.p.recoveryCodes.join("  ")}</p></div>
        </>)}
      </OneTimeDialog>
    </>
  );
}

function NewStaff({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (email: string, p: SetupPackage) => void }) {
  const { catalog } = useAdmin();
  const withStepUp = useStepUp();
  const [f, setF] = useState({ email: "", displayName: "", role: "support", ips: "" });
  const [busy, setBusy] = useState(false);
  async function submit(ev: FormEvent) {
    ev.preventDefault(); setBusy(true);
    try {
      const ipAllowList = f.ips.split(/[\s,]+/).filter(Boolean);
      const r = await withStepUp(() => apiSend<{ setup: SetupPackage }>("POST", "/admin/admins", { email: f.email, displayName: f.displayName, role: f.role, ipAllowList }));
      onCreated(f.email, r.setup); setF({ email: "", displayName: "", role: "support", ips: "" });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  const role = catalog?.roles.find((r) => r.id === f.role);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>New staff account</DialogTitle><DialogDescription>Give the least access that does the job. A super admin can change it later.</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Name"><Input required maxLength={80} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
          <Field label="Work email"><Input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Role" hint={role ? `Can: ${role.perms.join(", ")}` : undefined}>
            <select className={`${selectCls} w-full`} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{(catalog?.roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
          </Field>
          <Field label="Only allow sign-in from (optional)" hint="Addresses or ranges separated by spaces, e.g. 203.0.113.7 or 198.51.100.0/24. Empty means anywhere."><Input value={f.ips} onChange={(e) => setF({ ...f, ips: e.target.value })} /></Field>
          <Button type="submit" className="w-full" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Create account</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
