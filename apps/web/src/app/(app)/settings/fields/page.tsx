"use client";
import { CUSTOM_ENTITIES, CUSTOM_TYPES, type MessageKey } from "@routenorth/shared";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Field { id: string; entity: string; key: string; label: string; labelFr: string | null; type: string; options: string[] | null; required: boolean; active: boolean }
interface Status { id: string; key: string; label: string; labelFr: string | null; baseStatus: string; color: string; active: boolean }
const STATES = ["unassigned", "assigned", "started", "arrived", "done", "failed", "cancelled"];
const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1").slice(0, 40);

function Fields() {
  const { t } = useI18n(); const { toast } = useToast();
  const [entity, setEntity] = useState("job");
  const list = useApi<Field[]>(`/platform/custom-fields?entity=${entity}`);
  const [f, setF] = useState({ label: "", labelFr: "", type: "text", options: "", required: false });
  async function add() {
    try {
      await apiSend("POST", "/platform/custom-fields", { entity, key: slug(f.label), label: f.label, labelFr: f.labelFr || undefined, type: f.type, options: f.type === "select" ? f.options.split(",").map((x) => x.trim()).filter(Boolean) : undefined, required: f.required });
      setF({ label: "", labelFr: "", type: "text", options: "", required: false }); list.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function toggle(x: Field) { try { await apiSend("PATCH", `/platform/custom-fields/${x.id}`, { active: !x.active }); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function del(x: Field) { if (!window.confirm(t("cf_deleteAsk"))) return; try { await apiSend("DELETE", `/platform/custom-fields/${x.id}`); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <div className="stack">
      <p className="meta small">{t("cf_note")}</p>
      <label>{t("cf_record")}<select value={entity} onChange={(e) => setEntity(e.target.value)}>{CUSTOM_ENTITIES.map((x) => <option key={x} value={x}>{t(`cf_e_${x}` as MessageKey)}</option>)}</select></label>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.loaded ? <SkeletonList rows={2} /> : list.data!.length === 0 ? <EmptyState title={t("cf_none")} body={t("cf_noneBody")} /> : (
        <table className="ptable"><thead><tr><th>{t("cf_name")}</th><th>{t("cf_type")}</th><th><span className="sr-only">{t("actions")}</span></th></tr></thead>
          <tbody>{list.data!.map((x) => <tr key={x.id}><td>{x.label}{x.labelFr ? ` / ${x.labelFr}` : ""}{x.required && " *"}{!x.active && <> <Chip>{t("cf_off")}</Chip></>}<div className="meta small"><code>{x.key}</code></div></td>
            <td>{t(`cf_t_${x.type}` as MessageKey)}{x.options?.length ? ` (${x.options.join(", ")})` : ""}</td>
            <td><button className="btn" onClick={() => void toggle(x)}>{x.active ? t("cf_hide") : t("cf_show")}</button> <button className="btn" onClick={() => void del(x)}>{t("delete")}</button></td></tr>)}</tbody></table>
      )}
      <div className="card" style={{ padding: "var(--s3) var(--s4)" }}>
        <div className="grid2">
          <label>{t("cf_name")}<input value={f.label} maxLength={80} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
          <label>{t("cf_nameFr")}<input value={f.labelFr} maxLength={80} onChange={(e) => setF({ ...f, labelFr: e.target.value })} /></label>
          <label>{t("cf_type")}<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{CUSTOM_TYPES.map((x) => <option key={x} value={x}>{t(`cf_t_${x}` as MessageKey)}</option>)}</select></label>
          {f.type === "select" && <label>{t("cf_options")}<input value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} placeholder="A, B, C" /></label>}
        </div>
        <label className="row"><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /> {t("cf_required")}</label>
        <button className="btn primary" disabled={!slug(f.label)} onClick={() => void add()}>{t("cf_add")}</button>
      </div>
    </div>
  );
}

function Statuses() {
  const { t } = useI18n(); const { toast } = useToast();
  const list = useApi<Status[]>("/platform/statuses");
  const [f, setF] = useState({ label: "", labelFr: "", baseStatus: "assigned", color: "#d97706" });
  async function add() { try { await apiSend("POST", "/platform/statuses", { key: slug(f.label), label: f.label, labelFr: f.labelFr || undefined, baseStatus: f.baseStatus, color: f.color }); setF({ ...f, label: "", labelFr: "" }); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function del(s: Status) { try { await apiSend("DELETE", `/platform/statuses/${s.id}`); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <div className="stack">
      <p className="meta small">{t("cs_note")}</p>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.loaded ? <SkeletonList rows={2} /> : list.data!.length === 0 ? <EmptyState title={t("cs_none")} /> : (
        <table className="ptable"><thead><tr><th>{t("cf_name")}</th><th>{t("cs_while")}</th><th><span className="sr-only">{t("actions")}</span></th></tr></thead>
          <tbody>{list.data!.map((s) => <tr key={s.id}><td><span aria-hidden style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: s.color, marginInlineEnd: 6 }} />{s.label}{s.labelFr ? ` / ${s.labelFr}` : ""}</td><td>{t(`v_${s.baseStatus}` as MessageKey)}</td><td><button className="btn" onClick={() => void del(s)}>{t("delete")}</button></td></tr>)}</tbody></table>
      )}
      <div className="card" style={{ padding: "var(--s3) var(--s4)" }}>
        <div className="grid2">
          <label>{t("cf_name")}<input value={f.label} maxLength={60} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
          <label>{t("cf_nameFr")}<input value={f.labelFr} maxLength={60} onChange={(e) => setF({ ...f, labelFr: e.target.value })} /></label>
          <label>{t("cs_while")}<select value={f.baseStatus} onChange={(e) => setF({ ...f, baseStatus: e.target.value })}>{STATES.map((s) => <option key={s} value={s}>{t(`v_${s}` as MessageKey)}</option>)}</select></label>
          <label>{t("cs_color")}<input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></label>
        </div>
        <button className="btn primary" disabled={!slug(f.label)} onClick={() => void add()}>{t("cf_add")}</button>
      </div>
    </div>
  );
}

export default function FieldsPage() {
  const { t } = useI18n(); const { can } = useMe();
  const [tab, setTab] = useState("fields");
  if (!can("settings.manage")) return <div className="content"><ErrorState forbidden /></div>;
  return (
    <div className="content">
      <PageHead title={t("navFields")} subtitle={t("cf_subtitle")} />
      <Tabs label={t("navFields")} value={tab} onChange={setTab} tabs={[{ id: "fields", label: t("cf_tabFields") }, { id: "statuses", label: t("cf_tabStatuses") }]} />
      <div role="tabpanel" style={{ marginTop: "var(--s4)" }}>{tab === "fields" ? <Fields /> : <Statuses />}</div>
    </div>
  );
}
