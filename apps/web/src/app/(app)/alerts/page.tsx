"use client";
import type { MessageKey } from "@routenorth/shared";
import { Check, Trash2 } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { metricLabel } from "@/lib/analytics";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Alert { id: string; kind: string; severity: string; title: string; firstAt: string; lastAt: string; count: number; status: string; rule: string | null }
interface Endpoint { id: string; kind: string; label: string; target: string; enabled: boolean }
interface Rule { id: string; name: string; kind: string; params: Record<string, unknown>; severity: string; endpointIds: string[]; notifyInapp: boolean; quietStart: string | null; quietEnd: string | null; groupMinutes: number; active: boolean }

const KINDS = ["late_risk", "off_route", "long_idle", "speeding", "geofence", "offline", "harsh_driving", "document_expiry", "maintenance_due", "cost_anomaly", "custom_metric", "needs_break", "help_request", "fatigue", "checkin_missed", "crash"] as const;
/** What each kind of rule asks for: a name, a kind of input and a starting value. */
const PARAMS: Record<string, { key: string; type: "number" | "select" | "metric"; def: unknown; options?: string[] }[]> = {
  late_risk: [{ key: "minutes", type: "number", def: 15 }], off_route: [{ key: "meters", type: "number", def: 2000 }], long_idle: [{ key: "minutes", type: "number", def: 20 }],
  speeding: [{ key: "kmh", type: "number", def: 110 }, { key: "fixes", type: "number", def: 3 }], geofence: [{ key: "event", type: "select", def: "enter", options: ["enter", "exit"] }],
  offline: [{ key: "minutes", type: "number", def: 30 }], harsh_driving: [{ key: "minutes", type: "number", def: 30 }], document_expiry: [{ key: "days", type: "number", def: 30 }],
  maintenance_due: [{ key: "includeSoon", type: "select", def: "true", options: ["true", "false"] }], cost_anomaly: [{ key: "threshold", type: "number", def: 3.5 }],
  needs_break: [{ key: "afterHours", type: "number", def: 5 }], help_request: [], fatigue: [], checkin_missed: [], crash: [],
  custom_metric: [{ key: "metric", type: "metric", def: "onTimeRate" }, { key: "op", type: "select", def: "lt", options: ["gt", "gte", "lt", "lte"] }, { key: "value", type: "number", def: 90 }, { key: "period", type: "select", def: "today", options: ["today", "yesterday", "last7"] }],
};

export default function AlertsPage() {
  const { t } = useI18n();
  const { can } = useMe();
  const [tab, setTab] = useState("inbox");
  const manage = can("alerts.manage");
  return (
    <div className="content">
      <PageHead title={t("navAlerts")} subtitle={t("al_subtitle")} />
      <Tabs label={t("navAlerts")} value={tab} onChange={setTab} tabs={[{ id: "inbox", label: t("al_inbox") }, { id: "rules", label: t("al_rules") }, ...(manage ? [{ id: "dest", label: t("al_destinations") }] : [])]} />
      {tab === "inbox" && <Inbox manage={manage} />}
      {tab === "rules" && <Rules manage={manage} />}
      {tab === "dest" && <Destinations />}
    </div>
  );
}

function Inbox({ manage }: { manage: boolean }) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [status, setStatus] = useState("active");
  const list = useApi<Alert[]>(`/alerts?status=${status}&limit=100`, { intervalMs: 30_000 });
  async function act(id: string, what: "acknowledge" | "resolve") { try { await apiSend("POST", `/alerts/${id}/${what}`); list.reload(); } catch (e) { toast((e as Error).message); } }
  return (
    <>
      <div className="row">
        <div className="seg" role="group" aria-label={t("al_status")}>{["active", "open", "acknowledged", "resolved"].map((s) => <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>{t(`al_s_${s}` as MessageKey)}</button>)}</div>
        <span className="nav-spacer" />
        {manage && <button className="btn" onClick={() => void apiSend("POST", "/alerts/evaluate").then(() => { list.reload(); toast(t("al_checked")); })}>{t("al_checkNow")}</button>}
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.loaded ? <SkeletonList rows={5} h={52} /> : (list.data ?? []).length === 0 ? <EmptyState title={t("al_empty")} body={t("al_emptyBody")} /> : (
        <ul className="plainlist">
          {list.data!.map((a) => (
            <li key={a.id} className="card" style={{ padding: "var(--s3) var(--s4)" }}>
              <div className="row">
                <div className="grow">
                  <span className={`sev ${a.severity}`} aria-label={t(`sev_${a.severity}` as MessageKey)} /> <strong className={a.status === "open" ? "status-open" : ""}>{a.title}</strong>
                  <div className="meta small">{a.rule ?? t(`al_k_${a.kind}` as MessageKey)} · {new Date(a.lastAt).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" })}{a.count > 1 ? ` · ${t("al_times", { n: a.count })}` : ""} · {t(`al_s_${a.status}` as MessageKey)}</div>
                </div>
                {a.status === "open" && <button className="btn" onClick={() => void act(a.id, "acknowledge")}><Check size={15} /> {t("al_ack")}</button>}
                {a.status !== "resolved" && <button className="btn" onClick={() => void act(a.id, "resolve")}>{t("al_resolve")}</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Rules({ manage }: { manage: boolean }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const rules = useApi<Rule[]>("/r/alert-rules");
  const eps = useApi<Endpoint[]>(manage ? "/r/notification-endpoints" : null);
  const metrics = useApi<Record<string, unknown>>(manage ? "/analytics/metrics" : null);
  const blank = (): Partial<Rule> => ({ name: "", kind: "long_idle", params: { minutes: 20 }, severity: "warn", endpointIds: [], notifyInapp: true, groupMinutes: 30, active: true });
  const [draft, setDraft] = useState<Partial<Rule> | null>(null);
  const [preview, setPreview] = useState<{ count: number; matches: { title: string }[] } | null>(null);
  const setKind = (kind: string) => setDraft((d) => ({ ...d!, kind, params: Object.fromEntries((PARAMS[kind] ?? []).map((p) => [p.key, p.type === "select" && p.def === "true" ? true : p.def])) }));
  async function save() {
    try {
      const body = { name: draft!.name, kind: draft!.kind, params: draft!.params, severity: draft!.severity, endpointIds: draft!.endpointIds, notifyInapp: draft!.notifyInapp, quietStart: draft!.quietStart || null, quietEnd: draft!.quietEnd || null, groupMinutes: draft!.groupMinutes, active: draft!.active };
      if (draft!.id) await apiSend("PATCH", `/r/alert-rules/${draft!.id}`, body); else await apiSend("POST", "/r/alert-rules", body);
      setDraft(null); setPreview(null); rules.reload(); toast(t("al_ruleSaved"));
    } catch (e) { toast((e as Error).message); }
  }
  async function test() { try { setPreview(await apiSend("POST", "/alerts/preview", { kind: draft!.kind, params: draft!.params })); } catch (e) { toast((e as Error).message); } }
  const sentence = (r: Partial<Rule>) => t(`al_if_${r.kind}` as MessageKey, Object.fromEntries(Object.entries(r.params ?? {}).map(([k, v]) => [k, String(v)])));

  return (
    <>
      {manage && !draft && <div className="row"><button className="btn primary" onClick={() => setDraft(blank())}>{t("al_newRule")}</button></div>}
      {draft && (
        <section className="card" style={{ padding: "var(--s4)" }} aria-label={t("al_newRule")}>
          <h3>{t("al_ruleBuilder")}</h3>
          <div className="form-grid">
            <label className="field">{t("f_name")}<input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={120} /></label>
            <label className="field">{t("al_when")}<select value={draft.kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{t(`al_k_${k}` as MessageKey)}</option>)}</select></label>
            {(PARAMS[draft.kind!] ?? []).map((p) => (
              <label key={p.key} className="field">{t(`al_p_${p.key}` as MessageKey)}
                {p.type === "number" ? <input type="number" step="any" value={String(draft.params?.[p.key] ?? p.def)} onChange={(e) => setDraft({ ...draft, params: { ...draft.params, [p.key]: Number(e.target.value) } })} />
                  : p.type === "metric" ? <select value={String(draft.params?.[p.key] ?? p.def)} onChange={(e) => setDraft({ ...draft, params: { ...draft.params, [p.key]: e.target.value } })}>{Object.keys(metrics.data ?? {}).map((k) => <option key={k} value={k}>{t(metricLabel(k))}</option>)}</select>
                  : <select value={String(draft.params?.[p.key] ?? p.def)} onChange={(e) => setDraft({ ...draft, params: { ...draft.params, [p.key]: p.options!.includes("true") ? e.target.value === "true" : e.target.value } })}>{p.options!.map((o) => <option key={o} value={o}>{t(`al_o_${o}` as MessageKey)}</option>)}</select>}
              </label>
            ))}
            <label className="field">{t("f_severity")}<select value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value })}>{["info", "warn", "critical"].map((s) => <option key={s} value={s}>{t(`sev_${s}` as MessageKey)}</option>)}</select></label>
            <label className="field">{t("al_group")}<input type="number" min={0} max={1440} value={draft.groupMinutes ?? 30} onChange={(e) => setDraft({ ...draft, groupMinutes: Number(e.target.value) })} /></label>
            <label className="field">{t("al_quietFrom")}<input type="time" value={draft.quietStart?.slice(0, 5) ?? ""} onChange={(e) => setDraft({ ...draft, quietStart: e.target.value })} /></label>
            <label className="field">{t("al_quietTo")}<input type="time" value={draft.quietEnd?.slice(0, 5) ?? ""} onChange={(e) => setDraft({ ...draft, quietEnd: e.target.value })} /></label>
          </div>
          <p className="meta small">{t("al_quietHint")}</p>
          <fieldset><legend>{t("al_then")}</legend>
            <label className="check"><input type="checkbox" checked={draft.notifyInapp !== false} onChange={(e) => setDraft({ ...draft, notifyInapp: e.target.checked })} /> {t("al_inapp")}</label>
            {(eps.data ?? []).filter((e) => e.enabled).map((e) => (
              <label key={e.id} className="check"><input type="checkbox" checked={draft.endpointIds?.includes(e.id) ?? false} onChange={(ev) => setDraft({ ...draft, endpointIds: ev.target.checked ? [...(draft.endpointIds ?? []), e.id] : (draft.endpointIds ?? []).filter((x) => x !== e.id) })} /> {e.label} <span className="meta">({t(`v_${e.kind}` as MessageKey)})</span></label>
            ))}
            {(eps.data ?? []).length === 0 && <p className="meta small">{t("al_noDest")}</p>}
          </fieldset>
          <p><strong>{t("al_summary")}:</strong> {sentence(draft)}</p>
          {preview && <p role="status" className="meta">{t("al_previewResult", { n: preview.count })}{preview.matches.length > 0 && <>: {preview.matches.slice(0, 3).map((m) => m.title).join("; ")}</>}</p>}
          <div className="row"><button className="btn primary" disabled={!draft.name?.trim()} onClick={() => void save()}>{t("save")}</button><button className="btn" onClick={() => void test()}>{t("al_test")}</button><button className="btn" onClick={() => { setDraft(null); setPreview(null); }}>{t("cancel")}</button></div>
        </section>
      )}
      {rules.error ? <ErrorState error={rules.error} onRetry={rules.reload} /> : !rules.loaded ? <SkeletonList rows={3} h={52} /> : (rules.data ?? []).length === 0 && !draft ? <EmptyState title={t("al_noRules")} body={t("al_noRulesBody")} /> : (
        <ul className="plainlist">{(rules.data ?? []).map((r) => (
          <li key={r.id} className="card" style={{ padding: "var(--s3) var(--s4)" }}>
            <div className="row">
              <div className="grow"><span className={`sev ${r.severity}`} /> <strong>{r.name}</strong>{!r.active && <span className="meta"> · {t("al_off")}</span>}<div className="meta small">{sentence(r)}</div></div>
              {manage && <>
                <label className="switch"><input type="checkbox" checked={r.active} aria-label={t("f_active")} onChange={(e) => void apiSend("PATCH", `/r/alert-rules/${r.id}`, { active: e.target.checked }).then(rules.reload)} /></label>
                <button className="btn" onClick={() => setDraft(r)}>{t("edit")}</button>
                <button className="icon-btn" aria-label={t("delete")} onClick={() => window.confirm(t("al_confirmDelete", { name: r.name })) && void apiSend("DELETE", `/r/alert-rules/${r.id}`).then(rules.reload)}><Trash2 size={15} /></button>
              </>}
            </div>
          </li>
        ))}</ul>
      )}
    </>
  );
}

function Destinations() {
  const { t } = useI18n();
  const { toast } = useToast();
  const eps = useApi<Endpoint[]>("/r/notification-endpoints");
  const [kind, setKind] = useState("slack"); const [label, setLabel] = useState(""); const [target, setTarget] = useState("");
  async function add() {
    try { await apiSend("POST", "/r/notification-endpoints", { kind, label, target, enabled: true }); setLabel(""); setTarget(""); eps.reload(); } catch (e) { toast((e as Error).message); }
  }
  async function test(id: string) { try { const r = await apiSend<{ ok: boolean; error?: string }>("POST", `/alerts/endpoints/${id}/test`); toast(r.ok ? t("al_testSent") : r.error ?? t("error")); } catch (e) { toast((e as Error).message); } }
  const hint = kind === "email" ? "name@company.com" : kind === "sms" ? "+14165550123" : kind === "slack" ? "https://hooks.slack.com/services/…" : "https://…";
  return (
    <>
      <p className="meta">{t("al_destHint")}</p>
      <div className="row" style={{ alignItems: "end" }}>
        <label className="field">{t("f_kind")}<select value={kind} onChange={(e) => setKind(e.target.value)}>{["slack", "teams", "email", "sms", "webhook"].map((k) => <option key={k} value={k}>{t(`v_${k}` as MessageKey)}</option>)}</select></label>
        <label className="field">{t("f_label")}<input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} /></label>
        <label className="field grow">{t("f_target")}<input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={hint} /></label>
        <button className="btn primary" disabled={!label || !target} onClick={() => void add()}>{t("al_addDest")}</button>
      </div>
      {(kind === "email" || kind === "sms") && <p className="meta small">{t("al_needsAccount")}</p>}
      {eps.error ? <ErrorState error={eps.error} onRetry={eps.reload} /> : !eps.loaded ? <SkeletonList rows={2} h={44} /> : (eps.data ?? []).length === 0 ? <EmptyState title={t("al_noDestinations")} /> : (
        <ul className="plainlist">{eps.data!.map((e) => (
          <li key={e.id} className="card" style={{ padding: "var(--s3) var(--s4)" }}>
            <div className="row"><div className="grow"><strong>{e.label}</strong> <span className="meta">· {t(`v_${e.kind}` as MessageKey)} · {e.kind === "slack" || e.kind === "teams" || e.kind === "webhook" ? new URL(e.target).host : e.target}</span></div>
              <button className="btn" onClick={() => void test(e.id)}>{t("al_sendTest")}</button>
              <button className="icon-btn" aria-label={t("delete")} onClick={() => void apiSend("DELETE", `/r/notification-endpoints/${e.id}`).then(eps.reload)}><Trash2 size={15} /></button></div>
          </li>
        ))}</ul>
      )}
    </>
  );
}
