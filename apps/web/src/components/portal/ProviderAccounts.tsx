"use client";
import { Pause, Play, PlugZap, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/portal/parts";
import { apiSend } from "@/lib/api";
import { ago } from "@/lib/portal/data-sources";
import { useApi } from "@/lib/use-api";

interface Connection {
  id: string; provider: "geotab" | "samsara"; name: string; settings: Record<string, string>;
  status: "pending" | "ok" | "error" | "paused"; lastSyncAt: string | null; lastDataAt: string | null; lastError: string | null;
}

const STATUS = {
  pending: ["neutral", "Waiting for first pull"], ok: ["good", "Pulling"], error: ["bad", "Problem"], paused: ["neutral", "Paused"],
} as const;

const selectClass = "h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs";

/** Sign in to a Geotab or Samsara account so RouteNorth pulls positions from it every minute. */
export function ProviderAccounts() {
  const state = useApi<{ connections: Connection[]; polling: boolean }>("/portal/provider-connections", { intervalMs: 30_000 });
  const [provider, setProvider] = useState<"geotab" | "samsara">("geotab");
  const [f, setF] = useState({ server: "my.geotab.com", database: "", userName: "", region: "us", secret: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try { await fn(); toast.success(done); state.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "That did not work"); } finally { setBusy(false); }
  }
  const connect = () => run(async () => {
    const settings = provider === "geotab" ? { server: f.server, database: f.database, userName: f.userName } : { region: f.region };
    await apiSend("POST", "/portal/provider-connections", { provider, settings, secret: f.secret });
    setF({ ...f, secret: "" });
  }, "Connected. The first positions arrive within a minute or two.");
  const ready = f.secret.trim() && (provider === "samsara" || (f.database.trim() && f.userName.trim()));
  const list = state.data?.connections ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Or sign in to your provider account</CardTitle>
        <CardDescription>For Geotab and Samsara, which keep data in their own systems. RouteNorth signs in and pulls new positions every minute. No key or provider settings needed.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {state.data && !state.data.polling && (
          <p><StatusBadge tone="warn">Server setting missing</StatusBadge> <span className="text-muted-foreground">The ingest service needs <code className="rounded bg-muted px-1">JWT_SECRET</code> (the same value as the API) before it can pull.</span></p>
        )}
        <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Provider</span>
            <select className={selectClass} value={provider} onChange={(e) => setProvider(e.target.value as "geotab" | "samsara")}>
              <option value="geotab">Geotab (MyGeotab)</option><option value="samsara">Samsara</option>
            </select></label>
          {provider === "geotab" ? (
            <>
              <label className="grid gap-1"><span className="text-xs text-muted-foreground">Server</span><Input value={f.server} onChange={set("server")} placeholder="my.geotab.com" /></label>
              <label className="grid gap-1"><span className="text-xs text-muted-foreground">Database</span><Input value={f.database} onChange={set("database")} placeholder="The name you type when signing in" /></label>
              <label className="grid gap-1"><span className="text-xs text-muted-foreground">User name</span><Input value={f.userName} onChange={set("userName")} autoComplete="off" placeholder="A read-only user is enough" /></label>
              <label className="grid gap-1"><span className="text-xs text-muted-foreground">Password</span><Input type="password" value={f.secret} onChange={set("secret")} autoComplete="new-password" /></label>
            </>
          ) : (
            <>
              <label className="grid gap-1"><span className="text-xs text-muted-foreground">Region</span>
                <select className={selectClass} value={f.region} onChange={set("region")}><option value="us">North America (api.samsara.com)</option><option value="eu">Europe</option></select></label>
              <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-muted-foreground">API token (Samsara: Settings, API tokens; read access to vehicles and vehicle statistics)</span>
                <Input type="password" value={f.secret} onChange={set("secret")} autoComplete="off" /></label>
            </>
          )}
          <div className="sm:col-span-2"><Button type="submit" disabled={busy || !ready}><PlugZap /> Check and connect</Button></div>
        </form>
        <p className="text-xs text-muted-foreground">We check the login with the provider before saving it, store it encrypted, and never show it again. Built against the providers’ published APIs; not yet tried with a real customer account.</p>
        {list.length > 0 && (
          <ul className="divide-y">
            {list.map((c) => {
              const [tone, label] = STATUS[c.status];
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <span className="font-medium">{c.name}</span> <StatusBadge tone={tone}>{label}</StatusBadge>
                    <div className="text-xs text-muted-foreground">
                      {c.provider === "geotab" ? `${c.settings.database} on ${c.settings.server}` : `Samsara ${c.settings.region === "eu" ? "Europe" : "North America"}`}
                      {c.lastDataAt ? ` · last position ${ago(c.lastDataAt)}` : c.lastSyncAt ? ` · checked ${ago(c.lastSyncAt)}, nothing new` : ""}
                    </div>
                    {c.lastError && c.status === "error" && <div className="text-xs text-destructive">{c.lastError}</div>}
                  </div>
                  <div className="flex gap-1">
                    {c.status === "paused" || c.status === "error"
                      ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => apiSend("POST", `/portal/provider-connections/${c.id}/resume`), "Trying again now")}><Play /> {c.status === "paused" ? "Resume" : "Try again"}</Button>
                      : <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => apiSend("POST", `/portal/provider-connections/${c.id}/pause`), "Paused")}><Pause /> Pause</Button>}
                    <Button size="sm" variant="outline" disabled={busy} aria-label={`Remove ${c.name}`} onClick={() => { if (window.confirm(`Remove "${c.name}"? The saved login is deleted; positions already pulled stay.`)) void run(() => apiSend("DELETE", `/portal/provider-connections/${c.id}`), "Removed"); }}><Trash2 /></Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
