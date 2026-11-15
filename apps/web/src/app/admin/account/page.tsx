"use client";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useAdmin } from "@/components/admin/AdminShell";
import { Facts, Field, fail } from "@/components/admin/parts";
import { PageHeader } from "@/components/portal/parts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiSend } from "@/lib/api";

export default function AccountPage() {
  const { me, catalog, refreshMe } = useAdmin();
  const router = useRouter();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const mismatch = again !== "" && again !== next;
  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (mismatch) return;
    setBusy(true);
    try {
      await apiSend("POST", "/admin/me/password", { current: cur, next });
      toast.success("Password changed. Your other sign-ins were ended.");
      setCur(""); setNext(""); setAgain("");
      // Reload who I am first, so the console no longer thinks a password change is pending when it moves on.
      const was = me.mustChangePassword;
      await refreshMe();
      if (was) router.replace("/admin");
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  const role = catalog?.roles.find((r) => r.id === me.role);
  return (
    <>
      <PageHeader title="My account" description={me.mustChangePassword ? "Choose your own password before you do anything else. The temporary one only works once." : `${me.email} · ${me.roleLabel}`} crumbs={[{ label: "My account" }]} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Change password</CardTitle><CardDescription>At least 14 characters. A long phrase of unrelated words is best. Changing it signs you out of other devices.</CardDescription></CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-3">
              <Field label={me.mustChangePassword ? "Temporary password" : "Current password"}><Input type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
              <Field label="New password"><Input type="password" autoComplete="new-password" required minLength={14} maxLength={200} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
              <Field label="New password again"><Input type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={mismatch || undefined} /></Field>
              {mismatch && <p role="alert" className="text-sm text-destructive">The two do not match.</p>}
              <Button type="submit" disabled={busy || mismatch || next.length < 14}>{busy && <Loader2 className="animate-spin" />} Change password</Button>
            </form>
          </CardContent></Card>
        <Card><CardHeader><CardTitle>How your account is protected</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Facts rows={[
              ["Role", me.roleLabel], ["Second factor", "Authenticator app, required on every sign-in"],
              ["Sensitive actions", me.steppedUp ? "Unlocked for a few more minutes" : "Ask for a fresh code (valid 10 minutes)"],
              ["Session", "Ends after 30 minutes idle, or 8 hours in total"],
            ]} />
            {role && <div><p className="mb-1 text-sm font-medium">What your role can do</p><ul className="flex flex-wrap gap-1.5">{role.perms.map((p) => <li key={p} className="rounded-md bg-secondary px-2 py-0.5 text-xs">{p}</li>)}</ul></div>}
            <p className="text-sm text-muted-foreground">Lost your phone? Use a recovery code at sign-in, then ask a super admin to reset your credentials.</p>
          </CardContent></Card>
      </div>
    </>
  );
}
