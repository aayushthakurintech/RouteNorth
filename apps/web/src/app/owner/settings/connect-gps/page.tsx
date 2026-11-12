"use client";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Async } from "@/components/portal/states";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { ProviderAccounts } from "@/components/portal/ProviderAccounts";
import { apiSend } from "@/lib/api";
import { ago } from "@/lib/portal/data-sources";
import { useApi } from "@/lib/use-api";

interface Overview {
  ingestUrl: string | null; needs: string[];
  keys: { id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string }[];
  devices: { total: number; waiting: { id: string; externalId: string; lastSeen: string | null }[]; lastSeen: string | null };
  vehicles: { id: string; name: string }[];
}

function Code({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-10 text-xs leading-relaxed"><code>{text}</code></pre>
      <Button size="icon" variant="ghost" className="absolute right-1 top-1 size-7" aria-label="Copy" onClick={() => { void navigator.clipboard?.writeText(text); toast.success("Copied"); }}><Copy /></Button>
    </div>
  );
}

/** RouteNorth is software, not hardware: your trackers and provider stay as they are and send positions here with a key. */
export default function ConnectGpsPage() {
  const state = useApi<Overview>("/portal/gps-connect", { intervalMs: 15_000 });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try { await fn(); if (done) toast.success(done); state.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "That did not work"); } finally { setBusy(false); }
  }
  const make = () => run(async () => { const k = await apiSend<{ key: string }>("POST", "/portal/gps-connect/keys", { name }); setFresh(k.key); setName(""); });

  return (
    <>
      <PageHeader title="Connect your GPS" description="Keep the trackers and the GPS provider you already use. They send positions to RouteNorth; there is nothing to buy from us."
        actions={<Button asChild size="sm" variant="outline"><Link href="/owner/settings/data-sources">Data sources</Link></Button>} />
      <Async state={state}>
        {(d) => {
          const url = d.ingestUrl ?? "https://<ingest-address>";
          const key = fresh ?? "YOUR_KEY";
          return (
            <div className="space-y-6">
              {d.needs.length > 0 && (
                <Card><CardContent className="pt-6 text-sm">
                  <StatusBadge tone="warn">Server setting missing</StatusBadge>
                  <p className="mt-2 text-muted-foreground">The person who runs the server needs to set {d.needs.map((n, i) => <code key={i} className="rounded bg-muted px-1 py-0.5">{n}</code>)}. Until then the addresses below show a placeholder.</p>
                </CardContent></Card>
              )}

              <Card>
                <CardHeader><CardTitle>1. Make a key</CardTitle><CardDescription>One key per provider or server, so you can switch one off without touching the others. It belongs to your company only: data sent with it can only land in your account.</CardDescription></CardHeader>
                <CardContent className="space-y-4">
                  <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void make(); }}>
                    <Input aria-label="Key name" className="max-w-xs" placeholder="Name, for example the provider" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                    <Button type="submit" disabled={busy || !name.trim()}><KeyRound /> Make key</Button>
                  </form>
                  {fresh && (
                    <div className="space-y-2 rounded-md border border-primary/40 p-3" role="status">
                      <p className="text-sm font-medium">Copy this key now. It is shown once and cannot be shown again.</p>
                      <Code text={fresh} />
                      <Button size="sm" variant="outline" onClick={() => setFresh(null)}>I have saved it</Button>
                    </div>
                  )}
                  {d.keys.length > 0 ? (
                    <ul className="divide-y text-sm">
                      {d.keys.map((k) => (
                        <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                          <div><span className="font-medium">{k.name}</span> <code className="text-xs text-muted-foreground">{k.prefix}…</code>
                            <div className="text-xs text-muted-foreground">{k.lastUsedAt ? `Last used ${ago(k.lastUsedAt)}` : "Not used yet"}</div></div>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm(`Switch off "${k.name}"? Anything still using it stops sending within a minute.`)) void run(() => apiSend("DELETE", `/portal/gps-connect/keys/${k.id}`), "Key switched off"); }}><Trash2 /> Switch off</Button>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-sm text-muted-foreground">No keys yet.</p>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>2. Tell your provider where to send positions</CardTitle><CardDescription>Pick the line that matches what you have.</CardDescription></CardHeader>
                <CardContent className="space-y-6 text-sm">
                  <section className="space-y-2">
                    <h3 className="font-medium">Your provider can send data to a web address (webhook or HTTP push)</h3>
                    <p className="text-muted-foreground">Send a POST with the key in the Authorization header. Up to 500 positions per request; speed in km/h, mph or knots. Vehicles appear under “New devices” below the first time they report.</p>
                    <Code text={`POST ${url}/ingest/feed\nAuthorization: Bearer ${key}\nContent-Type: application/json\n\n{ "deviceId": "truck-12",\n  "positions": [ { "time": "2026-11-12T14:00:00Z", "lat": 43.65, "lng": -79.38,\n    "speedKmh": 62, "heading": 90, "ignition": true, "odometerKm": 18234.5 } ] }`} />
                  </section>
                  <section className="space-y-2">
                    <h3 className="font-medium">You or your provider run a Traccar server</h3>
                    <p className="text-muted-foreground">In Traccar’s configuration, forward every position to RouteNorth. The key goes on the end of the address because Traccar cannot set headers. Traccar decodes more than 200 tracker makes, so this covers most hardware.</p>
                    <Code text={`<entry key='forward.enable'>true</entry>\n<entry key='forward.json'>true</entry>\n<entry key='forward.url'>${url}/ingest/feed/traccar?key=${key}</entry>`} />
                  </section>
                  <section className="space-y-2">
                    <h3 className="font-medium">Your provider only offers its own API (Geotab, Samsara)</h3>
                    <p className="text-muted-foreground">Skip the key: sign in to the provider account in the next box and RouteNorth pulls the positions itself. Other providers (Motive and similar) are not built yet; ask whether they can forward to a web address or a Traccar-style server, and tell us which one you use.</p>
                  </section>
                  <p className="text-xs text-muted-foreground">Nothing here has been tried against a real provider yet; the address and formats were tested with stand-in senders. If a provider cannot be made to work, <Link href="/help" className="underline underline-offset-2">tell us</Link>.</p>
                </CardContent>
              </Card>

              <ProviderAccounts />

              <Card>
                <CardHeader>
                  <CardTitle>3. New devices</CardTitle>
                  <CardDescription>{d.devices.total === 0 ? "Nothing has arrived yet. This list fills in by itself within a few seconds of the first position." : `${d.devices.total} device${d.devices.total === 1 ? "" : "s"} arrived through your feeds${d.devices.lastSeen ? `, last position ${ago(d.devices.lastSeen)}` : ""}.`}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {d.devices.waiting.length > 0 && (
                    <>
                      <p>{d.devices.waiting.length} not on a vehicle yet, so they do not appear on the map or in vehicle reports.</p>
                      <ul className="grid gap-1 sm:grid-cols-2">{d.devices.waiting.slice(0, 20).map((x) => <li key={x.id} className="truncate rounded border px-2 py-1"><code>{x.externalId}</code> <span className="text-xs text-muted-foreground">{x.lastSeen ? ago(x.lastSeen) : "no position yet"}</span></li>)}</ul>
                      <div className="flex flex-wrap gap-2">
                        <Button disabled={busy} onClick={() => void run(async () => { const r = await apiSend<{ created: number }>("POST", "/portal/gps-connect/create-vehicles", {}); toast.success(`Made ${r.created} vehicle${r.created === 1 ? "" : "s"}. Rename them on the vehicles page.`); })}>Make a vehicle for each</Button>
                        <Button asChild variant="outline"><Link href="/devices">Match to vehicles I already have</Link></Button>
                      </div>
                    </>
                  )}
                  {d.devices.total > 0 && d.devices.waiting.length === 0 && <p className="text-muted-foreground">Every device is on a vehicle. <Link href="/owner/vehicles" className="underline underline-offset-2">Open vehicles</Link></p>}
                </CardContent>
              </Card>
            </div>
          );
        }}
      </Async>
    </>
  );
}
