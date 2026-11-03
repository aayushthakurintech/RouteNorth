"use client";
import type { MessageKey } from "@routenorth/shared";
import { Copy, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, Modal, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Catalog { triggers: string[]; ops: string[]; actions: string[]; fields: string[]; customerEvents: string[]; templates: { id: string; name: string; description: string }[] }
interface Cond { field: string; op: string; value: string | number | boolean | string[] }
interface Act { type: string; params: Record<string, unknown> }
interface Workflow { id?: string; name: string; description: string | null; active: boolean; trigger: { kind: string; minutes?: number; stops?: number }; match: "all" | "any"; conditions: Cond[]; actions: Act[]; runCount?: number }
interface Endpoint { id: string; label: string; kind: string; enabled: boolean }
interface Run { id: string; workflow: string; status: "ok" | "failed" | "skipped"; detail: { reason?: string; results?: { type: string; ok: boolean; detail?: string }[] } | null; at: string }

const MINUTE_TRIGGERS = ["job.unassigned_for", "job.not_started_for", "driver.minutes_away"];
const blank = (): Workflow => ({ name: "", description: "", active: true, trigger: { kind: "job.created" }, match: "all", conditions: [], actions: [{ type: "create_alert", params: { severity: "warn", title: "" } }] });
const defaultParams = (type: string): Record<string, unknown> => ({
  notify: { endpointIds: [], subject: "RouteNorth", text: "" }, notify_customer: { event: "on_the_way" }, notify_driver: { text: "" }, create_alert: { severity: "warn", title: "" },
  set_job: { priority: "high" }, request_approval: { title: "", kind: "custom" }, create_invoice: {}, replan_route: {},
}[type] ?? {});

/** Automation: if this happens, and these things are true, do that. No code. */
export default function AutomationPage() {
  const { t } = useI18n();
  const { can } = useMe();
  const [tab, setTab] = useState("workflows");
  return (
    <div className="content">
      <PageHead title={t("navAutomation")} subtitle={t("wf_subtitle")} />
      <Tabs label={t("navAutomation")} value={tab} onChange={setTab} tabs={[{ id: "workflows", label: t("wf_workflows") }, { id: "runs", label: t("wf_runs") }, ...(can("integrations.manage") ? [{ id: "webhooks", label: t("wh_title") }] : [])]} />
      {tab === "workflows" && <Workflows manage={can("alerts.manage")} />}
      {tab === "runs" && <Runs />}
      {tab === "webhooks" && <Webhooks />}
    </div>
  );
}

function Workflows({ manage }: { manage: boolean }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const list = useApi<Workflow[]>("/r/workflows");
  const cat = useApi<Catalog>("/automation/catalog");
  const eps = useApi<Endpoint[]>(manage ? "/r/notification-endpoints" : null);
  const [draft, setDraft] = useState<Workflow | null>(null);
  const [test, setTest] = useState<{ name: string; matches: boolean; wouldDo: { type: string; preview: string | null }[] } | null>(null);

  async function save() {
    if (!draft) return;
    const body = { name: draft.name, description: draft.description || null, active: draft.active, trigger: draft.trigger, match: draft.match, conditions: draft.conditions, actions: draft.actions };
    try {
      if (draft.id) await apiSend("PATCH", `/r/workflows/${draft.id}`, body); else await apiSend("POST", "/r/workflows", body);
      setDraft(null); list.reload(); toast(t("wf_saved"));
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function useTemplate(id: string) { try { await apiSend("POST", `/automation/templates/${id}/use`); list.reload(); toast(t("wf_added")); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function tryIt(w: Workflow) { try { setTest({ name: w.name, ...(await apiSend<{ matches: boolean; wouldDo: { type: string; preview: string | null }[] }>("POST", `/automation/workflows/${w.id}/test`, {})) }); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  const sentence = (w: Workflow) => `${t(`wf_tr_${w.trigger.kind}` as MessageKey, { n: w.trigger.minutes ?? w.trigger.stops ?? 0 })}${w.conditions.length ? ` · ${t("wf_conditionsN", { n: w.conditions.length })}` : ""} → ${w.actions.map((a) => t(`wf_a_${a.type}` as MessageKey)).join(", ")}`;
  const setAct = (i: number, a: Act) => setDraft((d) => d && { ...d, actions: d.actions.map((x, j) => (j === i ? a : x)) });
  const setCond = (i: number, c: Cond) => setDraft((d) => d && { ...d, conditions: d.conditions.map((x, j) => (j === i ? c : x)) });
  const setTrig = (kind: string) => setDraft((d) => d && { ...d, trigger: MINUTE_TRIGGERS.includes(kind) ? { kind, minutes: 15 } : kind === "driver.stops_away" ? { kind, stops: 2 } : { kind } });

  return (
    <>
      {manage && !draft && <div className="row"><button className="btn primary" onClick={() => setDraft(blank())}><Plus size={15} /> {t("wf_new")}</button></div>}
      {draft && cat.data && (
        <section className="card" style={{ padding: "var(--s4)" }} aria-label={t("wf_builder")}>
          <h2>{t("wf_builder")}</h2>
          <div className="form-grid">
            <label className="field">{t("f_name")}<input value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label className="field">{t("wf_description")}<input value={draft.description ?? ""} maxLength={500} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
          </div>
          <h3>{t("wf_when")}</h3>
          <div className="row">
            <select aria-label={t("wf_when")} value={draft.trigger.kind} onChange={(e) => setTrig(e.target.value)}>{cat.data.triggers.map((k) => <option key={k} value={k}>{t(`wf_tr_${k}` as MessageKey, { n: "…" })}</option>)}</select>
            {MINUTE_TRIGGERS.includes(draft.trigger.kind) && <label className="field">{t("wf_minutes")}<input type="number" min={1} max={1440} value={draft.trigger.minutes ?? 15} onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, minutes: Number(e.target.value) } })} /></label>}
            {draft.trigger.kind === "driver.stops_away" && <label className="field">{t("wf_stops")}<input type="number" min={1} max={50} value={draft.trigger.stops ?? 2} onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, stops: Number(e.target.value) } })} /></label>}
          </div>
          <h3>{t("wf_only")}</h3>
          <div className="row"><span>{t("wf_match")}</span><select aria-label={t("wf_match")} value={draft.match} onChange={(e) => setDraft({ ...draft, match: e.target.value as "all" | "any" })}><option value="all">{t("wf_all")}</option><option value="any">{t("wf_any")}</option></select></div>
          {draft.conditions.map((c, i) => (
            <div className="row" key={i}>
              <input list="wf-fields" aria-label={t("wf_field")} value={c.field} onChange={(e) => setCond(i, { ...c, field: e.target.value })} />
              <select aria-label={t("wf_op")} value={c.op} onChange={(e) => setCond(i, { ...c, op: e.target.value })}>{cat.data!.ops.map((o) => <option key={o} value={o}>{t(`wf_op_${o}` as MessageKey)}</option>)}</select>
              <input aria-label={t("wf_value")} value={Array.isArray(c.value) ? c.value.join(", ") : String(c.value)} onChange={(e) => { const v = e.target.value; setCond(i, { ...c, value: c.op === "in" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v }); }} />
              <button className="icon-btn" aria-label={t("delete")} onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>
            </div>
          ))}
          <datalist id="wf-fields">{cat.data.fields.map((f) => <option key={f} value={f} />)}</datalist>
          <div className="row"><button className="btn sm" onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { field: "job.priority", op: "eq", value: "urgent" }] })}><Plus size={14} /> {t("wf_addCondition")}</button></div>
          <h3>{t("wf_then")}</h3>
          {draft.actions.map((a, i) => (
            <fieldset key={i} className="card" style={{ padding: "var(--s3)", marginBottom: "var(--s2)" }}>
              <div className="row">
                <select aria-label={t("wf_then")} value={a.type} onChange={(e) => setAct(i, { type: e.target.value, params: defaultParams(e.target.value) })}>{cat.data!.actions.map((x) => <option key={x} value={x}>{t(`wf_a_${x}` as MessageKey)}</option>)}</select>
                <span className="grow" />
                <button className="icon-btn" aria-label={t("delete")} disabled={draft.actions.length < 2} onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>
              </div>
              <ActionFields a={a} set={(x) => setAct(i, x)} cat={cat.data!} eps={(eps.data ?? []).filter((e) => e.enabled)} />
            </fieldset>
          ))}
          <div className="row"><button className="btn sm" onClick={() => setDraft({ ...draft, actions: [...draft.actions, { type: "create_alert", params: defaultParams("create_alert") }] })}><Plus size={14} /> {t("wf_addAction")}</button></div>
          <p className="meta small">{t("wf_vars")}</p>
          <div className="row">
            <label className="check"><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> {t("f_active")}</label>
            <span className="grow" />
            <button className="btn" onClick={() => setDraft(null)}>{t("cancel")}</button>
            <button className="btn primary" disabled={!draft.name.trim()} onClick={() => void save()}>{t("save")}</button>
          </div>
        </section>
      )}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.loaded ? <SkeletonList rows={3} h={60} /> : (list.data ?? []).length === 0 && !draft ? <EmptyState title={t("wf_empty")} body={t("wf_emptyBody")} /> : (
        <ul className="plainlist">
          {(list.data ?? []).map((w) => (
            <li key={w.id} className="card" style={{ padding: "var(--s3) var(--s4)" }}>
              <div className="row">
                <div className="grow"><strong>{w.name}</strong> {!w.active && <Chip>{t("al_off")}</Chip>}<div className="meta small">{sentence(w)}</div>{w.description && <div className="small">{w.description}</div>}<div className="meta small">{t("wf_ranN", { n: w.runCount ?? 0 })}</div></div>
                {manage && <>
                  <label className="switch"><input type="checkbox" checked={w.active} aria-label={t("f_active")} onChange={(e) => void apiSend("PATCH", `/r/workflows/${w.id}`, { active: e.target.checked }).then(list.reload)} /></label>
                  <button className="btn" onClick={() => void tryIt(w)}><Play size={14} /> {t("wf_try")}</button>
                  <button className="btn" onClick={() => setDraft(w)}>{t("edit")}</button>
                  <button className="icon-btn" aria-label={t("delete")} onClick={() => window.confirm(t("al_confirmDelete", { name: w.name })) && void apiSend("DELETE", `/r/workflows/${w.id}`).then(list.reload)}><Trash2 size={15} /></button>
                </>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {manage && cat.data && (
        <section aria-label={t("wf_templates")}>
          <h2>{t("wf_templates")}</h2>
          <ul className="plainlist" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: "var(--s3)" }}>
            {cat.data.templates.map((x) => (
              <li key={x.id} className="card" style={{ padding: "var(--s3) var(--s4)" }}>
                <strong>{x.name}</strong><p className="meta small">{x.description}</p>
                <button className="btn sm" onClick={() => void useTemplate(x.id)}><Copy size={14} /> {t("wf_use")}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Modal open={!!test} onClose={() => setTest(null)} title={test ? t("wf_testTitle", { name: test.name }) : ""}>
        {test && <><p role="status">{test.matches ? t("wf_testYes") : t("wf_testNo")}</p>{test.wouldDo.length > 0 && <ul>{test.wouldDo.map((a, i) => <li key={i}><strong>{t(`wf_a_${a.type}` as MessageKey)}</strong>{a.preview ? `: ${a.preview}` : ""}</li>)}</ul>}<p className="meta small">{t("wf_testNote")}</p></>}
      </Modal>
    </>
  );
}

function ActionFields({ a, set, cat, eps }: { a: Act; set: (a: Act) => void; cat: Catalog; eps: Endpoint[] }) {
  const { t } = useI18n();
  const p = a.params;
  const up = (k: string, v: unknown) => set({ ...a, params: { ...p, [k]: v } });
  switch (a.type) {
    case "notify": {
      const ids = (p.endpointIds as string[]) ?? [];
      return (
        <div className="form-grid">
          <fieldset><legend>{t("wf_sendTo")}</legend>{eps.map((e) => <label key={e.id} className="check"><input type="checkbox" checked={ids.includes(e.id)} onChange={(ev) => up("endpointIds", ev.target.checked ? [...ids, e.id] : ids.filter((x) => x !== e.id))} /> {e.label}</label>)}{eps.length === 0 && <p className="meta small">{t("al_noDest")}</p>}</fieldset>
          <label className="field">{t("wf_subject")}<input value={String(p.subject ?? "")} maxLength={120} onChange={(e) => up("subject", e.target.value)} /></label>
          <label className="field">{t("wf_text")}<textarea rows={2} value={String(p.text ?? "")} maxLength={500} onChange={(e) => up("text", e.target.value)} /></label>
        </div>
      );
    }
    case "notify_customer":
      return (
        <div className="form-grid">
          <label className="field">{t("wf_customerMsg")}<select value={String(p.event ?? "")} onChange={(e) => up("event", e.target.value || undefined)}><option value="">{t("wf_ownText")}</option>{cat.customerEvents.map((e) => <option key={e} value={e}>{t(`cx_ev_${e}` as MessageKey)}</option>)}</select></label>
          {!p.event && <label className="field">{t("wf_text")}<textarea rows={2} value={String(p.text ?? "")} maxLength={500} onChange={(e) => up("text", e.target.value)} /></label>}
        </div>
      );
    case "notify_driver": return <label className="field">{t("wf_text")}<textarea rows={2} value={String(p.text ?? "")} maxLength={300} onChange={(e) => up("text", e.target.value)} /></label>;
    case "create_alert":
      return (
        <div className="form-grid">
          <label className="field">{t("f_severity")}<select value={String(p.severity ?? "warn")} onChange={(e) => up("severity", e.target.value)}>{["info", "warn", "critical"].map((s) => <option key={s} value={s}>{t(`sev_${s}` as MessageKey)}</option>)}</select></label>
          <label className="field">{t("f_title")}<input value={String(p.title ?? "")} maxLength={160} onChange={(e) => up("title", e.target.value)} /></label>
        </div>
      );
    case "set_job":
      return (
        <div className="form-grid">
          <label className="field">{t("f_priority")}<select value={String(p.priority ?? "")} onChange={(e) => up("priority", e.target.value || undefined)}><option value="">–</option>{["low", "normal", "high", "urgent"].map((s) => <option key={s} value={s}>{t(`v_${s}` as MessageKey)}</option>)}</select></label>
          <label className="field">{t("wf_addTag")}<input value={String(p.addTag ?? "")} maxLength={30} onChange={(e) => up("addTag", e.target.value || undefined)} /></label>
        </div>
      );
    case "request_approval": return <label className="field">{t("f_title")}<input value={String(p.title ?? "")} maxLength={160} onChange={(e) => up("title", e.target.value)} /></label>;
    default: return <p className="meta small">{t(`wf_a_${a.type}_help` as MessageKey)}</p>;
  }
}

function Runs() {
  const { t, locale } = useI18n();
  const runs = useApi<Run[]>("/automation/runs", { intervalMs: 30_000 });
  if (runs.error) return <ErrorState error={runs.error} onRetry={runs.reload} />;
  if (!runs.loaded) return <SkeletonList rows={4} h={44} />;
  if ((runs.data ?? []).length === 0) return <EmptyState title={t("wf_noRuns")} body={t("wf_noRunsBody")} />;
  return (
    <ul className="plainlist">{runs.data!.map((r) => (
      <li key={r.id} className="card" style={{ padding: "var(--s2) var(--s4)" }}>
        <div className="row"><strong className="grow">{r.workflow}</strong><Chip tone={r.status === "ok" ? "ok" : r.status === "failed" ? "danger" : undefined}>{t(`wf_run_${r.status}` as MessageKey)}</Chip><span className="meta small">{new Date(r.at).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" })}</span></div>
        {r.detail && <div className="meta small">{r.detail.reason ?? (r.detail.results ?? []).map((x) => `${t(`wf_a_${x.type}` as MessageKey)}: ${x.ok ? "OK" : (x.detail ?? "failed")}`).join(" · ")}</div>}
      </li>))}
    </ul>
  );
}

interface Hook { id: string; label: string; url: string; events: string[]; active: boolean; failedLastWeek: number; lastDeliveredAt: string | null }
interface Delivery { id: string; kind: string; status: string; attempts: number; responseStatus: number | null; lastError: string | null; nextAttemptAt: string | null; createdAt: string }

function Webhooks() {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const hooks = useApi<Hook[]>("/webhooks");
  const events = useApi<string[]>("/webhooks/events");
  const [draft, setDraft] = useState<{ id?: string; label: string; url: string; events: string[] } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [view, setView] = useState<Hook | null>(null);
  const deliveries = useApi<Delivery[]>(view ? `/webhooks/${view.id}/deliveries` : null);

  async function save() {
    if (!draft) return;
    try {
      if (draft.id) await apiSend("PATCH", `/webhooks/${draft.id}`, draft);
      else setSecret((await apiSend<{ secret: string }>("POST", "/webhooks", draft)).secret);
      setDraft(null); hooks.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function ping(h: Hook) { try { const r = await apiSend<{ status: string; responseStatus: number | null; lastError: string | null }>("POST", `/webhooks/${h.id}/test`); toast(r.status === "ok" ? t("wh_pingOk") : t("wh_pingFail", { why: r.lastError ?? String(r.responseStatus ?? "") })); hooks.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function rotate(h: Hook) { if (!window.confirm(t("wh_confirmRotate"))) return; try { setSecret((await apiSend<{ secret: string }>("POST", `/webhooks/${h.id}/rotate-secret`)).secret); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function retry(id: string) { try { await apiSend("POST", `/webhooks/deliveries/${id}/retry`); deliveries.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }

  return (
    <>
      <p className="meta">{t("wh_intro")}</p>
      {!draft && <div className="row"><button className="btn primary" onClick={() => setDraft({ label: "", url: "https://", events: [] })}><Plus size={15} /> {t("wh_new")}</button></div>}
      {draft && (
        <section className="card" style={{ padding: "var(--s4)" }}>
          <div className="form-grid">
            <label className="field">{t("f_label")}<input value={draft.label} maxLength={80} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
            <label className="field">{t("wh_url")}<input type="url" value={draft.url} maxLength={500} onChange={(e) => setDraft({ ...draft, url: e.target.value })} /></label>
          </div>
          <fieldset><legend>{t("wh_events")}</legend><p className="meta small">{t("wh_eventsHelp")}</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))", gap: 4 }}>{(events.data ?? []).map((e) => <label key={e} className="check"><input type="checkbox" checked={draft.events.includes(e)} onChange={(ev) => setDraft({ ...draft, events: ev.target.checked ? [...draft.events, e] : draft.events.filter((x) => x !== e) })} /> {e}</label>)}</div>
          </fieldset>
          <div className="row"><button className="btn" onClick={() => setDraft(null)}>{t("cancel")}</button><button className="btn primary" disabled={!draft.label.trim() || !draft.url.startsWith("https://")} onClick={() => void save()}>{t("save")}</button></div>
        </section>
      )}
      {hooks.error ? <ErrorState error={hooks.error} onRetry={hooks.reload} /> : !hooks.loaded ? <SkeletonList rows={2} h={60} /> : (hooks.data ?? []).length === 0 && !draft ? <EmptyState title={t("wh_empty")} body={t("wh_emptyBody")} /> : (
        <ul className="plainlist">{(hooks.data ?? []).map((h) => (
          <li key={h.id} className="card" style={{ padding: "var(--s3) var(--s4)" }}>
            <div className="row">
              <div className="grow"><strong>{h.label}</strong> {!h.active && <Chip>{t("al_off")}</Chip>} {h.failedLastWeek > 0 && <Chip tone="danger">{t("wh_failed", { n: h.failedLastWeek })}</Chip>}
                <div className="meta small" style={{ wordBreak: "break-all" }}>{h.url}</div>
                <div className="meta small">{h.events.length ? t("wh_eventsN", { n: h.events.length }) : t("wh_allEvents")} · {h.lastDeliveredAt ? t("wh_last", { time: new Date(h.lastDeliveredAt).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" }) }) : t("wh_never")}</div></div>
              <label className="switch"><input type="checkbox" checked={h.active} aria-label={t("f_active")} onChange={(e) => void apiSend("PATCH", `/webhooks/${h.id}`, { active: e.target.checked }).then(hooks.reload)} /></label>
              <button className="btn" onClick={() => void ping(h)}>{t("wh_ping")}</button>
              <button className="btn" onClick={() => setView(h)}>{t("wh_log")}</button>
              <button className="btn" onClick={() => setDraft({ id: h.id, label: h.label, url: h.url, events: h.events })}>{t("edit")}</button>
              <button className="btn" onClick={() => void rotate(h)}>{t("wh_rotate")}</button>
              <button className="icon-btn" aria-label={t("delete")} onClick={() => window.confirm(t("al_confirmDelete", { name: h.label })) && void apiSend("DELETE", `/webhooks/${h.id}`).then(hooks.reload)}><Trash2 size={15} /></button>
            </div>
          </li>))}
        </ul>
      )}
      <p className="meta small">{t("wh_verify")}</p>
      <Modal open={!!secret} onClose={() => setSecret(null)} title={t("wh_secretTitle")} actions={<button className="btn primary" onClick={() => setSecret(null)}>{t("close")}</button>}>
        <p>{t("wh_secretHelp")}</p><code style={{ wordBreak: "break-all", display: "block", padding: 8, background: "var(--surface-2)" }}>{secret}</code>
        <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(secret ?? ""); toast(t("copied")); }}><Copy size={14} /> {t("copy")}</button>
      </Modal>
      <Modal open={!!view} onClose={() => setView(null)} title={view ? `${t("wh_log")}: ${view.label}` : ""}>
        {!deliveries.loaded ? <SkeletonList rows={3} h={36} /> : (deliveries.data ?? []).length === 0 ? <p className="meta">{t("wh_noLog")}</p> : (
          <ul className="plainlist">{deliveries.data!.map((d) => (
            <li key={d.id} className="row"><span className="grow"><strong>{d.kind}</strong> <Chip tone={d.status === "ok" ? "ok" : d.status === "failed" ? "danger" : "warn"}>{t(`wh_s_${d.status}` as MessageKey)}</Chip><span className="meta small"> {d.responseStatus ?? ""} {d.lastError ?? ""} · {t("wh_attempts", { n: d.attempts })} · {new Date(d.createdAt).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" })}</span></span>{d.status === "failed" && <button className="btn sm" onClick={() => void retry(d.id)}>{t("retry")}</button>}</li>))}
          </ul>
        )}
      </Modal>
    </>
  );
}
