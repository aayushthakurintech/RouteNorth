"use client";
import type { MessageKey } from "@routenorth/shared";
import { Send, Sparkles } from "lucide-react";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, Kpi, PageHead, SkeletonList, TabDef, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

type Tone = "ok" | "warn" | "danger" | "info";
const levelTone = (l: string): Tone => (l === "high" ? "danger" : l === "medium" ? "warn" : "ok");
const num = (n: number | null | undefined, d = 1) => (n == null ? "–" : (Math.round(n * 10 ** d) / 10 ** d).toLocaleString());

interface Intent { type: string; fromId?: string; toId?: string; date?: string; notify?: boolean; template?: string; range?: string; groupBy?: string | null; routeHint?: string | null; reason?: string; name?: string }
interface Answer { text: string; source: "rules" | "ai"; intent: Intent; preview: { from?: string; to?: string; date?: string; stops?: string[]; count?: number; customers?: number; spec?: Record<string, unknown> } | null }
interface ReportResult { columns: { key: string; label: string }[]; rows: Record<string, unknown>[]; total: number }

/** Today's briefing: what needs attention, most urgent first. */
function Briefing() {
  const { t } = useI18n();
  const b = useApi<{ date: string; day: { routes: number; stops: number; done: number }; items: { key: string; severity: "info" | "warn" | "critical"; count: number; examples: string[]; link: string }[] }>("/ai/briefing", { intervalMs: 60_000 });
  if (b.error) return <ErrorState error={b.error} onRetry={b.reload} />;
  if (!b.loaded) return <SkeletonList rows={4} h={56} />;
  const d = b.data!;
  return (
    <div className="stack">
      <div className="kpi-row">
        <Kpi label={t("ai_routesToday")} value={d.day.routes} />
        <Kpi label={t("ai_stopsToday")} value={d.day.stops} />
        <Kpi label={t("ai_stopsDone")} value={d.day.done} />
      </div>
      {d.items.length === 0 ? <EmptyState title={t("ai_allClear")} body={t("ai_allClearBody")} /> : (
        <ul className="plainlist">
          {d.items.map((i) => (
            <li key={i.key} className="card" style={{ padding: "var(--s3) var(--s4)" }}>
              <div className="row">
                <div className="grow">
                  <strong>{t(`ai_b_${i.key}` as MessageKey, { n: i.count })}</strong> <Chip tone={i.severity === "critical" ? "danger" : i.severity === "warn" ? "warn" : "info"}>{t(`ai_sev_${i.severity}` as MessageKey)}</Chip>
                  <div className="meta small">{i.examples.join(" · ")}{i.count > i.examples.length ? ` · +${i.count - i.examples.length}` : ""}</div>
                </div>
                <a className="btn" href={i.link}>{t("ai_open")}</a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Late() {
  const { t, locale } = useI18n();
  const l = useApi<{ stops: { id: string; name: string; route: string; driver: string | null; slackMin: number; probability: number; level: string }[] }>("/ai/late", { intervalMs: 30_000 });
  if (l.error) return <ErrorState error={l.error} onRetry={l.reload} />;
  if (!l.loaded) return <SkeletonList rows={3} />;
  void locale;
  if (l.data!.stops.length === 0) return <EmptyState title={t("ai_noLate")} body={t("ai_noLateBody")} />;
  return (
    <table className="ptable">
      <thead><tr><th>{t("ai_stop")}</th><th>{t("f_driver")}</th><th className="tnum">{t("ai_slack")}</th><th className="tnum">{t("ai_chance")}</th><th>{t("ai_risk")}</th></tr></thead>
      <tbody>{l.data!.stops.map((s) => <tr key={s.id}><td>{s.name}<div className="meta small">{s.route}</div></td><td>{s.driver ?? "–"}</td><td className="tnum">{s.slackMin} {t("ai_min")}</td><td className="tnum">{Math.round(s.probability * 100)}%</td><td><Chip tone={levelTone(s.level)}>{t(`ai_risk_${s.level}` as MessageKey)}</Chip></td></tr>)}</tbody>
    </table>
  );
}

function Explain({ routeId: initial }: { routeId?: string }) {
  const { t } = useI18n();
  const today = new Date().toLocaleDateString("en-CA");
  const [date, setDate] = useState(today);
  const [picked, setPicked] = useState(initial ?? "");
  const routes = useApi<{ routes: { id: string; name: string; driver: string | null; lateMin: number }[] }>(`/ai/explain/routes?date=${date}`);
  const x = useApi<{ route: { name: string }; worstLateMin: number; lateStops: { name: string; lateMin: number }[]; causes: { kind: string; minutes: number | null; stop?: string; reason?: string }[] }>(picked ? `/ai/explain?routeId=${picked}` : null);
  return (
    <div className="stack">
      <div className="row">
        <label>{t("f_date")} <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setPicked(""); }} /></label>
        <label>{t("ai_route")} <select value={picked} onChange={(e) => setPicked(e.target.value)}><option value="">{t("ai_pickRoute")}</option>{(routes.data?.routes ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}{r.driver ? ` · ${r.driver}` : ""}{r.lateMin > 0 ? ` · +${r.lateMin} ${t("ai_min")}` : ""}</option>)}</select></label>
      </div>
      {x.error && <ErrorState error={x.error} onRetry={x.reload} />}
      {picked && x.loaded && x.data && (
        <div className="card" style={{ padding: "var(--s4)" }}>
          <h2>{x.data.route.name}</h2>
          {x.data.worstLateMin <= 0 ? <p>{t("ai_onTime")}</p> : (
            <>
              <p>{t("ai_wasLate", { name: x.data.route.name, n: x.data.worstLateMin })}</p>
              <ul>{x.data.causes.map((c, i) => <li key={i}>{t(`ai_cause_${c.kind}` as MessageKey, { n: c.minutes ?? 0, stop: c.stop ?? "", reason: c.reason ?? "" })}</li>)}</ul>
              <p className="meta small">{t("ai_noTraffic")}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Health() {
  const { t } = useI18n();
  const v = useApi<{ vehicles: { vehicleId: string; name: string; score: number; level: string; reasons: { key: string; points: number; value?: number }[] }[] }>("/ai/breakdown");
  if (v.error) return <ErrorState error={v.error} onRetry={v.reload} />;
  if (!v.loaded) return <SkeletonList rows={3} />;
  if (v.data!.vehicles.length === 0) return <EmptyState title={t("ai_noVehicles")} />;
  return (
    <div className="stack">
      <p className="meta small">{t("ai_healthNote")}</p>
      <table className="ptable">
        <thead><tr><th>{t("f_vehicle")}</th><th className="tnum">{t("ai_score")}</th><th>{t("ai_risk")}</th><th>{t("ai_why")}</th></tr></thead>
        <tbody>{v.data!.vehicles.map((x) => <tr key={x.vehicleId}><td>{x.name}</td><td className="tnum">{x.score}</td><td><Chip tone={levelTone(x.level)}>{t(`ai_risk_${x.level}` as MessageKey)}</Chip></td><td className="small">{x.reasons.slice(0, 3).map((r) => t(`ai_h_${r.key}` as MessageKey, { n: r.value ?? 0 })).join(" · ") || "–"}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function Forecast() {
  const { t, locale } = useI18n();
  const f = useApi<{ days: { date: string; jobs: number; low: number; high: number; drivers: number; booked: number; shortBy: number }[]; drivers: number; stopsPerDriver: number; enoughHistory: boolean }>("/ai/forecast?days=14");
  if (f.error) return <ErrorState error={f.error} onRetry={f.reload} />;
  if (!f.loaded) return <SkeletonList rows={4} />;
  const d = f.data!;
  if (d.days.length === 0) return <EmptyState title={t("ai_noHistory")} body={t("ai_noHistoryBody")} />;
  const day = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString(locale === "fr" ? "fr-CA" : "en-CA", { weekday: "short", month: "short", day: "numeric" });
  return (
    <div className="stack">
      <div className="kpi-row"><Kpi label={t("ai_driversNow")} value={d.drivers} /><Kpi label={t("ai_stopsPerDriver")} value={d.stopsPerDriver} /></div>
      {!d.enoughHistory && <p className="meta small">{t("ai_littleHistory")}</p>}
      <table className="ptable">
        <thead><tr><th>{t("f_date")}</th><th className="tnum">{t("ai_expectedJobs")}</th><th className="tnum">{t("ai_range")}</th><th className="tnum">{t("ai_booked")}</th><th className="tnum">{t("ai_driversNeeded")}</th></tr></thead>
        <tbody>{d.days.map((x) => <tr key={x.date}><td>{day(x.date)}</td><td className="tnum">{x.jobs}</td><td className="tnum">{x.low}–{x.high}</td><td className="tnum">{x.booked}</td><td className="tnum">{x.drivers}{x.shortBy > 0 && <> <Chip tone="warn">{t("ai_short", { n: x.shortBy })}</Chip></>}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function Learned() {
  const { t } = useI18n();
  const { toast } = useToast();
  const { can } = useMe();
  const st = useApi<{ customers: { key: string; samples: number; medianMin: number; plannedMin: number | null; diffMin: number | null }[] }>("/ai/learned/stop-times");
  const sp = useApi<{ byHour: { hour: number; avgKmh: number; samples: number; slowdown: number | null }[]; byDriver: { driverId: string; name: string; avgKmh: number; samples: number }[] }>("/ai/learned/speeds");
  async function apply(customer: string, minutes: number) {
    try { const r = await apiSend<{ jobs: number; stops: number }>("POST", "/ai/learned/stop-times/apply", { customer, minutes: Math.round(minutes) }); toast(t("ai_applied", { n: r.jobs + r.stops })); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  return (
    <div className="stack">
      <h2>{t("ai_stopTimes")}</h2>
      <p className="meta small">{t("ai_stopTimesNote")}</p>
      {st.error ? <ErrorState error={st.error} onRetry={st.reload} /> : !st.loaded ? <SkeletonList rows={3} /> : st.data!.customers.length === 0 ? <EmptyState title={t("ai_noLearned")} body={t("ai_noLearnedBody")} /> : (
        <table className="ptable">
          <thead><tr><th>{t("f_customer")}</th><th className="tnum">{t("ai_visits")}</th><th className="tnum">{t("ai_planned")}</th><th className="tnum">{t("ai_real")}</th><th /></tr></thead>
          <tbody>{st.data!.customers.slice(0, 30).map((c) => <tr key={c.key}><td>{c.key}</td><td className="tnum">{c.samples}</td><td className="tnum">{num(c.plannedMin)}</td><td className="tnum">{num(c.medianMin)}{c.diffMin != null && Math.abs(c.diffMin) >= 2 && <> <Chip tone={c.diffMin > 0 ? "warn" : "info"}>{c.diffMin > 0 ? "+" : ""}{num(c.diffMin)}</Chip></>}</td><td>{can("routes.write") && <button className="btn" onClick={() => void apply(c.key, c.medianMin)}>{t("ai_useReal")}</button>}</td></tr>)}</tbody>
        </table>
      )}
      <h2>{t("ai_speeds")}</h2>
      <p className="meta small">{t("ai_speedsNote")}</p>
      {sp.error ? <ErrorState error={sp.error} onRetry={sp.reload} /> : !sp.loaded ? <SkeletonList rows={3} /> : sp.data!.byHour.length === 0 ? <EmptyState title={t("ai_noLearned")} body={t("ai_noSpeedsBody")} /> : (
        <div className="grid2">
          <table className="ptable">
            <thead><tr><th>{t("ai_hour")}</th><th className="tnum">km/h</th><th className="tnum">{t("ai_slowdown")}</th></tr></thead>
            <tbody>{sp.data!.byHour.map((h) => <tr key={h.hour}><td>{String(h.hour).padStart(2, "0")}:00</td><td className="tnum">{num(h.avgKmh)}</td><td className="tnum">{h.slowdown ? `×${h.slowdown}` : "–"}</td></tr>)}</tbody>
          </table>
          <table className="ptable">
            <thead><tr><th>{t("f_driver")}</th><th className="tnum">km/h</th></tr></thead>
            <tbody>{sp.data!.byDriver.map((d) => <tr key={d.driverId}><td>{d.name}</td><td className="tnum">{num(d.avgKmh)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Tools() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [addr, setAddr] = useState("");
  const [fix, setFix] = useState<{ text: string; changes: string[]; issues: string[]; hits: { label: string; lat: number; lng: number; source: string }[] } | null>(null);
  const [doc, setDoc] = useState<{ kind: string; fields: Record<string, unknown> } | null>(null);
  const [kind, setKind] = useState<"delivery_note" | "receipt">("delivery_note");
  const status = useApi<{ readDocuments: boolean }>("/ai/status");
  async function run() { try { setFix(await apiSend("POST", "/ai/fix-address", { text: addr })); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function read(file: File | undefined) {
    if (!file) return;
    const image = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
    try { setDoc(await apiSend("POST", "/ai/read-document", { image, kind })); } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  return (
    <div className="stack">
      <h2>{t("ai_fixAddress")}</h2>
      <div className="row"><input aria-label={t("ai_fixAddress")} value={addr} maxLength={300} onChange={(e) => setAddr(e.target.value)} placeholder="5 - 22 elm ave, ottawa ON k1a0b1" style={{ flex: 1 }} /><button className="btn primary" disabled={addr.trim().length < 3} onClick={() => void run()}>{t("ai_tidy")}</button></div>
      {fix && (
        <div className="card" style={{ padding: "var(--s3) var(--s4)" }}>
          <strong>{fix.text}</strong>
          <div className="meta small">{fix.changes.map((c) => t(`ai_fix_${c}` as MessageKey)).join(" · ")}{fix.issues.length ? ` · ${fix.issues.map((c) => t(`ai_issue_${c}` as MessageKey)).join(", ")}` : ""}</div>
          {fix.hits.length === 0 ? <p className="small">{t("ai_noMatch")}</p> : <ul>{fix.hits.map((h, i) => <li key={i}>{h.label} <span className="meta small">({h.source === "saved" ? t("ai_saved") : t("ai_map")} · {h.lat.toFixed(4)}, {h.lng.toFixed(4)})</span></li>)}</ul>}
        </div>
      )}
      <h2>{t("ai_readPhoto")}</h2>
      <p className="meta small">{status.data?.readDocuments ? t("ai_readPhotoNote") : t("ai_readPhotoNeedsKey")}</p>
      <div className="row">
        <select aria-label={t("ai_docKind")} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="delivery_note">{t("ai_k_delivery_note")}</option><option value="receipt">{t("ai_k_receipt")}</option></select>
        <input type="file" accept="image/jpeg,image/png,image/webp" aria-label={t("ai_readPhoto")} disabled={!status.data?.readDocuments} onChange={(e) => void read(e.target.files?.[0])} />
      </div>
      {doc && <div className="card" style={{ padding: "var(--s3) var(--s4)" }}><p className="meta small">{t("ai_checkFields")}</p><dl>{Object.entries(doc.fields).map(([k, v]) => <div key={k} className="row"><dt style={{ minWidth: 140 }}>{k}</dt><dd>{v == null ? "–" : String(v)}</dd></div>)}</dl></div>}
    </div>
  );
}

function Ask() {
  const { t } = useI18n();
  const { toast } = useToast();
  const { can } = useMe();
  const [text, setText] = useState("");
  const [log, setLog] = useState<{ q: string; a?: Answer; done?: string; report?: ReportResult; err?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const examples = ["ai_ex1", "ai_ex2", "ai_ex3", "ai_ex4"] as const;
  const patch = (i: number, p: Partial<(typeof log)[number]>) => setLog((l) => l.map((x, k) => (k === i ? { ...x, ...p } : x)));

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    setBusy(true); setText("");
    const i = log.length;
    setLog((l) => [...l, { q }]);
    try {
      const a = await apiSend<Answer>("POST", "/ai/assistant", { text: q });
      patch(i, { a });
      if (a.intent.type === "report" && a.preview?.spec) patch(i, { report: await apiSend<ReportResult>("POST", "/reports/run", { spec: a.preview.spec }) });
    } catch (e) { patch(i, { err: (e as Error).message }); }
    setBusy(false);
  }
  async function confirm(i: number, a: Answer) {
    try { const r = await apiSend<{ moved: number; notified: number }>("POST", "/ai/assistant/run", { intent: a.intent }); patch(i, { done: t("ai_moved", { n: r.moved, m: r.notified }) }); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function saveReport(a: Answer) {
    const name = window.prompt(t("ai_reportName"), t(`ai_ex_report` as MessageKey));
    if (!name) return;
    try { await apiSend("POST", "/reports/saved", { name, spec: a.preview!.spec }); toast(t("ai_reportSaved")); } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }

  return (
    <div className="stack">
      <form className="row" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <input aria-label={t("ai_askLabel")} placeholder={t("ai_askPlaceholder")} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || !text.trim()} type="submit"><Send size={15} /> {t("ai_ask")}</button>
      </form>
      <div className="row" style={{ flexWrap: "wrap" }}>{examples.map((k) => <button key={k} className="btn" onClick={() => void ask(t(k))}>{t(k)}</button>)}</div>
      {log.length === 0 && <EmptyState icon={<Sparkles size={22} />} title={t("ai_askEmpty")} body={t("ai_askEmptyBody")} />}
      {[...log].map((m, i) => ({ m, i })).reverse().map(({ m, i }) => (
        <div key={i} className="card" style={{ padding: "var(--s3) var(--s4)" }}>
          <div className="meta small">{m.q}</div>
          {m.err && <p role="alert">{m.err}</p>}
          {m.a && <AnswerView a={m.a} done={m.done} report={m.report} canDispatch={can("routes.dispatch")} onConfirm={() => void confirm(i, m.a!)} onCancel={() => patch(i, { done: t("ai_cancelled") })} onSave={() => void saveReport(m.a!)} />}
        </div>
      ))}
    </div>
  );
}

function AnswerView({ a, done, report, canDispatch, onConfirm, onCancel, onSave }: { a: Answer; done?: string; report?: ReportResult; canDispatch: boolean; onConfirm: () => void; onCancel: () => void; onSave: () => void }) {
  const { t } = useI18n();
  const i = a.intent;
  if (i.type === "unknown") return <p>{i.reason === "driver_not_found" ? t("ai_noDriver", { name: i.name ?? "" }) : i.reason === "same_driver" ? t("ai_sameDriver") : t("ai_dontKnow")}</p>;
  if (i.type === "reassign" && a.preview) {
    const p = a.preview;
    return (
      <div className="stack">
        <p>{p.count === 0 ? t("ai_nothingToMove", { from: p.from ?? "" }) : t("ai_confirmMove", { n: p.count ?? 0, from: p.from ?? "", to: p.to ?? "", date: p.date ?? "" })}</p>
        {(p.stops?.length ?? 0) > 0 && <p className="meta small">{p.stops!.slice(0, 6).join(" · ")}{(p.stops!.length > 6) ? " …" : ""}</p>}
        {i.notify && (p.count ?? 0) > 0 && <p className="small">{t("ai_willTell", { n: p.customers ?? 0 })}</p>}
        {done ? <Chip tone="ok">{done}</Chip> : (p.count ?? 0) > 0 && (canDispatch ? <div className="row"><button className="btn primary" onClick={onConfirm}>{t("ai_confirm")}</button><button className="btn" onClick={onCancel}>{t("cancel")}</button></div> : <p className="meta small">{t("ai_needDispatch")}</p>)}
      </div>
    );
  }
  if (i.type === "report") {
    return (
      <div className="stack">
        <p>{t("ai_reportReady", { name: t(`ai_tpl_${i.template}` as MessageKey), range: t(`ai_range_${i.range}` as MessageKey) })}</p>
        {report ? (
          <>
            <table className="ptable"><thead><tr>{report.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>{report.rows.slice(0, 8).map((r, k) => <tr key={k}>{report.columns.map((c) => <td key={c.key}>{r[c.key] == null ? "–" : String(r[c.key])}</td>)}</tr>)}</tbody></table>
            <div className="row"><button className="btn" onClick={onSave}>{t("ai_saveReport")}</button><a className="btn" href="/reports">{t("ai_openReports")}</a></div>
          </>
        ) : <SkeletonList rows={2} />}
      </div>
    );
  }
  if (i.type === "briefing") return <Briefing />;
  if (i.type === "late") return <Late />;
  if (i.type === "forecast") return <Forecast />;
  if (i.type === "explain") return <Explain />;
  return null;
}

export default function AssistantPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState("ask");
  const tabs: TabDef[] = [
    { id: "ask", label: t("ai_tabAsk") }, { id: "today", label: t("ai_tabToday") }, { id: "late", label: t("ai_tabLate") }, { id: "delays", label: t("ai_tabDelays") },
    { id: "health", label: t("ai_tabHealth") }, { id: "forecast", label: t("ai_tabForecast") }, { id: "learned", label: t("ai_tabLearned") }, { id: "tools", label: t("ai_tabTools") },
  ];
  return (
    <div className="content">
      <PageHead title={t("navAssistant")} subtitle={t("ai_subtitle")} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label={t("navAssistant")} />
      <div role="tabpanel" style={{ marginTop: "var(--s4)" }}>
        {tab === "ask" && <Ask />}{tab === "today" && <Briefing />}{tab === "late" && <Late />}{tab === "delays" && <Explain />}
        {tab === "health" && <Health />}{tab === "forecast" && <Forecast />}{tab === "learned" && <Learned />}{tab === "tools" && <Tools />}
      </div>
    </div>
  );
}
