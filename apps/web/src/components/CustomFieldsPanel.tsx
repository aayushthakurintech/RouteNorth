"use client";
import type { MessageKey } from "@routenorth/shared";
import { useEffect, useState } from "react";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Def { key: string; label: string; labelFr: string | null; type: "text" | "number" | "date" | "bool" | "select"; options: string[] | null; required: boolean }
type Entity = "job" | "vehicle" | "driver" | "customer" | "depot";
const WRITE: Record<Entity, "routes.write" | "fleet.manage" | "customers.manage"> = { job: "routes.write", vehicle: "fleet.manage", driver: "fleet.manage", depot: "fleet.manage", customer: "customers.manage" };

/** The company's own fields for one record. Shows nothing when none are defined. */
export function CustomFieldsPanel({ entity, recordId }: { entity: Entity; recordId: string }) {
  const { t, locale } = useI18n(); const { can } = useMe(); const { toast } = useToast();
  const d = useApi<{ fields: Def[]; values: Record<string, string | number | boolean> }>(`/platform/custom?entity=${entity}&recordId=${recordId}`);
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  useEffect(() => { if (d.data) setForm(Object.fromEntries(d.data.fields.map((f) => [f.key, d.data!.values[f.key] ?? (f.type === "bool" ? false : "")] as const)) as Record<string, string | boolean>); }, [d.data]);
  if (!d.data || d.data.fields.length === 0) return null;
  const edit = can(WRITE[entity]);
  const label = (f: Def) => (locale === "fr" && f.labelFr ? f.labelFr : f.label);
  async function save() {
    try { await apiSend("PUT", "/platform/custom", { entity, recordId, values: form }); toast(t("cf_saved")); d.reload(); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  return (
    <fieldset className="stack" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
      <legend><strong>{t("cf_title")}</strong></legend>
      {d.data.fields.map((f) => (
        <label key={f.key} className={f.type === "bool" ? "row" : "field"}>
          {f.type !== "bool" && <>{label(f)}{f.required ? " *" : ""}</>}
          {f.type === "select" ? <select disabled={!edit} value={String(form[f.key] ?? "")} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}><option value="">–</option>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
            : f.type === "bool" ? <><input type="checkbox" disabled={!edit} checked={Boolean(form[f.key])} onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })} /> {label(f)}</>
            : <input disabled={!edit} type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} maxLength={500} value={String(form[f.key] ?? "")} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />}
        </label>
      ))}
      {edit && <div><button type="button" className="btn sm" onClick={() => void save()}>{t("cf_save" as MessageKey)}</button></div>}
    </fieldset>
  );
}
