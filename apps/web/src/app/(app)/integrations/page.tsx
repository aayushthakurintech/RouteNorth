"use client";
import { INTEGRATIONS, type MessageKey } from "@routenorth/shared";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorState, Chip, EmptyState, PageHead, SkeletonList, TabDef, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { API_URL, loadSession } from "@/lib/session";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Key { id: string; name: string; kind: string; scope: string; prefix: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string }
interface Made { id: string; key: string; kind: string; name: string }
const TONE: Record<string, "ok" | "info" | "warn" | undefined> = { built_in: "ok", api: "info", webhook: "info", feed: "info", external: "warn" };
const WEB = () => (typeof location === "undefined" ? "" : location.origin);
const day = (iso: string | null, loc: string) => (iso ? new Date(iso).toLocaleDateString(loc === "fr" ? "fr-CA" : "en-CA") : "–");

function Copyable({ text, label }: { text: string; label: string }) {
  const { toast } = useToast(); const { t } = useI18n();
  return (
    <div className="row" style={{ gap: 8, alignItems: "center" }}>
      <input readOnly aria-label={label} value={text} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, fontFamily: "var(--mono, monospace)", fontSize: 13 }} />
      <button type="button" className="btn" onClick={() => { void navigator.clipboard?.writeText(text); toast(t("integ_copied")); }}><Copy size={14} aria-hidden /> {t("integ_copy")}</button>
    </div>
  );
}

function Catalog() {
  const { t } = useI18n();
  const groups = [...new Set(INTEGRATIONS.map((i) => i.group))];
  return (
    <div className="stack">
      <p className="meta small">{t("integ_catalogNote")}</p>
      {groups.map((g) => (
        <section key={g} aria-label={t(`integ_g_${g}` as MessageKey)}>
          <h2>{t(`integ_g_${g}` as MessageKey)}</h2>
          <table className="ptable"><tbody>
            {INTEGRATIONS.filter((i) => i.group === g).map((i) => <tr key={i.id}><td>{i.name}</td><td><Chip tone={TONE[i.mode]}>{t(`integ_m_${i.mode}` as MessageKey)}</Chip></td></tr>)}
          </tbody></table>
        </section>
      ))}
      <p className="meta small">{t("integ_externalNote")}</p>
    </div>
  );
}

function Keys({ onCreated }: { onCreated?: () => void }) {
  const { t, locale } = useI18n(); const { toast } = useToast();
  const keys = useApi<Key[]>("/platform/keys");
  const [f, setF] = useState({ name: "", kind: "api", scope: "read", expires: "" });
  const [made, setMade] = useState<Made | null>(null);
  async function create() {
    try { setMade(await apiSend<Made>("POST", "/platform/keys", { name: f.name, kind: f.kind, scope: f.scope, expiresInDays: f.expires ? Number(f.expires) : undefined })); setF({ ...f, name: "" }); keys.reload(); onCreated?.(); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function revoke(id: string) { if (!window.confirm(t("integ_revokeAsk"))) return; try { await apiSend("DELETE", `/platform/keys/${id}`); keys.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <div className="stack">
      <p className="meta small">{t("integ_keysNote")}</p>
      {made && (
        <div className="card" role="status" style={{ padding: "var(--s3) var(--s4)" }}>
          <strong>{t("integ_keyOnce")}</strong>
          <Copyable text={made.key} label={t("integ_key")} />
          {made.kind === "inbound" && <><p className="small">{t("integ_emailUrl")}</p><Copyable text={`${API_URL}/inbound/email/${made.key}`} label={t("integ_emailUrl")} /></>}
          {made.kind === "feed" && <FeedLinks keyText={made.key} />}
          <button type="button" className="btn" onClick={() => setMade(null)}>{t("integ_done")}</button>
        </div>
      )}
      <div className="card" style={{ padding: "var(--s3) var(--s4)" }}>
        <div className="grid2">
          <label>{t("integ_name")}<input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>{t("integ_kind")}<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="api">{t("integ_k_api")}</option><option value="feed">{t("integ_k_feed")}</option><option value="inbound">{t("integ_k_inbound")}</option></select></label>
          {f.kind === "api" && <label>{t("integ_scope")}<select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="read">{t("integ_s_read")}</option><option value="write">{t("integ_s_write")}</option></select></label>}
          <label>{t("integ_expires")}<input type="number" min={1} max={3650} value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} placeholder="365" /></label>
        </div>
        <button className="btn primary" disabled={!f.name.trim()} onClick={() => void create()}>{t("integ_create")}</button>
      </div>
      {keys.error ? <ErrorState error={keys.error} onRetry={keys.reload} /> : !keys.loaded ? <SkeletonList rows={2} /> : keys.data!.length === 0 ? <EmptyState title={t("integ_noKeys")} /> : (
        <table className="ptable"><thead><tr><th>{t("integ_name")}</th><th>{t("integ_kind")}</th><th>{t("integ_key")}</th><th>{t("integ_lastUsed")}</th><th>{t("integ_expires")}</th><th /></tr></thead>
          <tbody>{keys.data!.map((k) => (
            <tr key={k.id}><td>{k.name}</td><td>{t(`integ_k_${k.kind}` as MessageKey)}{k.kind === "api" && <> · {t(`integ_s_${k.scope}` as MessageKey)}</>}</td><td><code>{k.prefix}…</code></td><td>{day(k.lastUsedAt, locale)}</td>
              <td>{k.revokedAt ? <Chip>{t("integ_revoked")}</Chip> : day(k.expiresAt, locale)}</td><td>{!k.revokedAt && <button className="btn" onClick={() => void revoke(k.id)}>{t("integ_revoke")}</button>}</td></tr>
          ))}</tbody></table>
      )}
    </div>
  );
}

function FeedLinks({ keyText }: { keyText: string }) {
  const { t } = useI18n();
  const ds = useApi<{ key: string; label: string }[]>(`/feeds/datasets?key=${keyText}`);
  const [d, setD] = useState("jobs");
  const base = `${API_URL}/feeds/data/${d}`;
  return (
    <div className="stack">
      <label>{t("integ_dataset")}<select value={d} onChange={(e) => setD(e.target.value)}>{(ds.data ?? [{ key: "jobs", label: "Jobs" }]).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></label>
      <p className="small">{t("integ_sheetsLink")}</p>
      <Copyable text={`=IMPORTDATA("${base}?format=csv&key=${keyText}")`} label={t("integ_sheetsLink")} />
      <p className="small">{t("integ_biLink")}</p>
      <Copyable text={`${base}?format=json&key=${keyText}`} label={t("integ_biLink")} />
      <p className="small">{t("integ_ndjsonLink")}</p>
      <Copyable text={`${base}?format=ndjson&key=${keyText}`} label={t("integ_ndjsonLink")} />
      <p className="small">{t("integ_calLink")}</p>
      <Copyable text={`${API_URL}/feeds/calendar.ics?key=${keyText}`} label={t("integ_calLink")} />
    </div>
  );
}

interface Doc { info: { title: string; description: string }; paths: Record<string, Record<string, { summary: string; tags?: string[] }>>; "x-webhooks": { description: string } }
function Docs() {
  const { t } = useI18n();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { fetch(`${API_URL}/public/openapi.json`).then((r) => r.json()).then(setDoc).catch(() => setErr(true)); }, []);
  if (err) return <ErrorState error={new Error("docs")} />;
  if (!doc) return <SkeletonList rows={4} />;
  return (
    <div className="stack">
      <p>{doc.info.description}</p>
      <div className="row"><a className="btn" href={`${API_URL}/public/openapi.json`} target="_blank" rel="noreferrer noopener">{t("integ_openapi")}</a></div>
      <h2>{t("integ_quick")}</h2>
      <pre className="card" style={{ padding: "var(--s3) var(--s4)", overflowX: "auto" }}>{`curl ${API_URL}/r/vehicles \\\n  -H "Authorization: Bearer rn_api_…"\n\ncurl -X POST ${API_URL}/r/jobs \\\n  -H "Authorization: Bearer rn_api_…" -H "Content-Type: application/json" \\\n  -d '{"title":"Deliver pallet","address":"1 Main St","scheduledDate":"2026-03-10"}'`}</pre>
      <h2>{t("integ_endpoints")}</h2>
      <table className="ptable"><thead><tr><th>{t("integ_method")}</th><th>{t("integ_path")}</th><th>{t("integ_what")}</th></tr></thead>
        <tbody>{Object.entries(doc.paths).flatMap(([p, ms]) => Object.entries(ms).map(([m, o]) => <tr key={`${m} ${p}`}><td><code>{m.toUpperCase()}</code></td><td><code>{p}</code></td><td>{o.summary}</td></tr>))}</tbody></table>
      <h2>{t("integ_webhooksTitle")}</h2>
      <p className="small">{doc["x-webhooks"].description}</p>
      <p className="small">{t("integ_sdk")}</p>
    </div>
  );
}

function Data() {
  const { t } = useI18n(); const { toast } = useToast();
  const [fmt, setFmt] = useState("quickbooks");
  const [range, setRange] = useState({ from: "", to: "" });
  async function download() {
    try {
      const q = new URLSearchParams({ format: fmt, ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) });
      const r = await fetch(`${API_URL}/platform/export/invoices?${q}`, { headers: { Authorization: `Bearer ${loadSession()?.token}` } });
      const j = (await r.json()) as { csv?: string; count?: number; message?: string };
      if (!r.ok || !j.csv) throw new Error(j.message ?? "failed");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([j.csv], { type: "text/csv" })); a.download = `invoices-${fmt}.csv`; a.click();
      toast(t("integ_exported", { n: j.count ?? 0 }));
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  const [made, setMade] = useState<string | null>(null);
  async function link() { try { setMade((await apiSend<Made>("POST", "/platform/keys", { name: "Data link", kind: "feed" })).key); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <div className="stack">
      <h2>{t("integ_accounting")}</h2>
      <p className="meta small">{t("integ_accountingNote")}</p>
      <div className="row">
        <label>{t("integ_format")}<select value={fmt} onChange={(e) => setFmt(e.target.value)}><option value="quickbooks">QuickBooks</option><option value="xero">Xero</option><option value="sage">Sage</option></select></label>
        <label>{t("integ_from")}<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label>{t("integ_to")}<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        <button className="btn primary" onClick={() => void download()}>{t("integ_download")}</button>
      </div>
      <h2>{t("integ_links")}</h2>
      <p className="meta small">{t("integ_linksNote")}</p>
      {made ? <div className="card" style={{ padding: "var(--s3) var(--s4)" }}><strong>{t("integ_keyOnce")}</strong><FeedLinks keyText={made} /></div> : <div><button className="btn" onClick={() => void link()}>{t("integ_makeLink")}</button></div>}
    </div>
  );
}

function Email() {
  const { t } = useI18n(); const { toast } = useToast();
  const [url, setUrl] = useState<string | null>(null);
  async function make() { try { const k = await apiSend<Made>("POST", "/platform/keys", { name: "Email to job", kind: "inbound" }); setUrl(`${API_URL}/inbound/email/${k.key}`); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <div className="stack">
      <p>{t("integ_emailNote")}</p>
      <ol className="small"><li>{t("integ_emailStep1")}</li><li>{t("integ_emailStep2")}</li><li>{t("integ_emailStep3")}</li></ol>
      <p className="meta small">{t("integ_emailRead")}</p>
      {url ? <div className="card" style={{ padding: "var(--s3) var(--s4)" }}><strong>{t("integ_keyOnce")}</strong><Copyable text={url} label={t("integ_emailUrl")} /></div> : <div><button className="btn primary" onClick={() => void make()}>{t("integ_makeEmail")}</button></div>}
      <p className="meta small">{t("integ_emailLimit")}</p>
    </div>
  );
}

function Widget() {
  const { t } = useI18n(); const { toast } = useToast();
  const org = useApi<{ settings: { platform: { widgetOrigins: string; whiteLabel: boolean } } }>("/org");
  const [origins, setOrigins] = useState<string | null>(null);
  const cur = origins ?? org.data?.settings.platform.widgetOrigins ?? "";
  async function save() { try { await apiSend("PUT", "/org", { settings: { platform: { widgetOrigins: cur } } }); setOrigins(null); org.reload(); toast(t("integ_saved")); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <div className="stack">
      <p>{t("integ_widgetNote")}</p>
      <pre className="card" style={{ padding: "var(--s3) var(--s4)", overflowX: "auto" }}>{`<div data-routenorth-track="TRACKING-LINK-CODE" data-height="520"></div>\n<script src="${WEB()}/widget.js" async></script>`}</pre>
      <p className="meta small">{t("integ_widgetCode")}</p>
      <label>{t("integ_widgetOrigins")}<input value={cur} maxLength={500} placeholder="https://shop.example.com" onChange={(e) => setOrigins(e.target.value)} /></label>
      <p className="meta small">{t("integ_widgetOriginsNote")}</p>
      <button className="btn primary" disabled={origins === null} onClick={() => void save()}>{t("save")}</button>
    </div>
  );
}

function Maps() {
  const { t } = useI18n(); const { toast } = useToast();
  const org = useApi<{ settings: { defaultMapProvider: string; platform: { mapKey: string; mapTileUrl: string } } }>("/org");
  const [d, setD] = useState<{ provider?: string; key?: string; url?: string }>({});
  if (org.error) return <ErrorState error={org.error} onRetry={org.reload} />;
  if (!org.loaded) return <SkeletonList rows={2} />;
  const p = d.provider ?? org.data!.settings.defaultMapProvider;
  async function save() {
    try { await apiSend("PUT", "/org", { settings: { defaultMapProvider: p, platform: { mapKey: d.key ?? org.data!.settings.platform.mapKey, mapTileUrl: d.url ?? org.data!.settings.platform.mapTileUrl } } }); setD({}); org.reload(); toast(t("integ_mapsSaved")); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  return (
    <div className="stack">
      <p>{t("integ_mapsNote")}</p>
      <label>{t("integ_provider")}<select value={p} onChange={(e) => setD({ ...d, provider: e.target.value })}>{["osm", "maptiler", "mapbox", "here", "google"].map((x) => <option key={x} value={x}>{t(`integ_p_${x}` as MessageKey)}</option>)}</select></label>
      {p === "google" && <p role="note" className="banner warn">{t("integ_googleNote")}</p>}
      <label>{t("integ_mapKey")}<input value={d.key ?? org.data!.settings.platform.mapKey} maxLength={200} onChange={(e) => setD({ ...d, key: e.target.value })} /></label>
      <label>{t("integ_tileUrl")}<input value={d.url ?? org.data!.settings.platform.mapTileUrl} maxLength={300} placeholder="https://tiles.example.com/{z}/{x}/{y}.png" onChange={(e) => setD({ ...d, url: e.target.value })} /></label>
      <p className="meta small">{t("integ_mapsKeyNote")}</p>
      <button className="btn primary" disabled={Object.keys(d).length === 0} onClick={() => void save()}>{t("save")}</button>
    </div>
  );
}

export default function IntegrationsPage() {
  const { t } = useI18n(); const { can } = useMe();
  const [tab, setTab] = useState("catalog");
  if (!can("api.manage") && !can("integrations.manage")) return <div className="content"><ErrorState forbidden /></div>;
  const tabs: TabDef[] = ["catalog", "keys", "docs", "data", "email", "widget", "maps"].map((id) => ({ id, label: t(`integ_tab_${id}` as MessageKey) }));
  return (
    <div className="content">
      <PageHead title={t("navIntegrations")} subtitle={t("integ_subtitle")} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label={t("navIntegrations")} />
      <div role="tabpanel" style={{ marginTop: "var(--s4)" }}>
        {tab === "catalog" && <Catalog />}{tab === "keys" && <Keys />}{tab === "docs" && <Docs />}{tab === "data" && <Data />}{tab === "email" && <Email />}{tab === "widget" && <Widget />}{tab === "maps" && <Maps />}
      </div>
    </div>
  );
}
