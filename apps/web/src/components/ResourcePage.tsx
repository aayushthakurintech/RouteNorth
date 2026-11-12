"use client";
import { Download, Paperclip, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { MessageKey } from "@routenorth/shared";
import { DataTable, type Column } from "@/components/ui/DataTable";
import BandsEditor from "@/components/BandsEditor";
import { CustomFieldsPanel } from "@/components/CustomFieldsPanel";
import { Chip, EmptyState, ErrorState, Modal, PageHead, SkeletonList } from "@/components/ui/primitives";
import { API_URL, loadSession } from "@/lib/session";
import { apiSend } from "@/lib/api";
import { downscaleImage } from "@/lib/image";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { formToBody, isoToLocalInput, RESOURCE_VIEWS, type FieldSchema, type ResourceSchema } from "@/lib/resources";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

export type Row = Record<string, unknown> & { id: string };
const AVOIDS = ["tolls", "highways", "ferries", "unpaved"];
const label = (t: (k: MessageKey) => string, key: string) => t(`f_${key}` as MessageKey);
const choice = (t: (k: MessageKey) => string, v: string) => t(`v_${v}` as MessageKey);

/** Lists the records that other records point at, so a form can offer them in a menu. */
function useRefOptions(ref: string | undefined, enabled: boolean) {
  const path = !enabled || !ref ? null : ref === "drivers" ? "/fleet/drivers" : ref === "@routes" ? null : ref === "teams" ? "/teams" : `/r/${ref}`;
  const data = useApi<{ id: string; name?: string; title?: string; task?: string }[]>(path);
  return (data.data ?? []).map((r) => ({ id: r.id, name: r.name ?? r.title ?? r.task ?? r.id.slice(0, 8) }));
}

function RefSelect({ f, value, onChange, owner, t }: { f: FieldSchema; value: unknown; onChange: (v: string) => void; owner?: unknown; t: (k: MessageKey) => string }) {
  const target = f.ref === "@owner" ? (owner === "driver" ? "drivers" : owner === "equipment" ? "equipment" : "vehicles") : f.ref;
  const opts = useRefOptions(target, true);
  return (
    <select required={f.required} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
      <option value="">{f.required ? t("rChoose") : t("rNone")}</option>
      {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

/** One input for one field of a record. */
function FieldInput({ f, form, set, long, t }: { f: FieldSchema; form: Record<string, unknown>; set: (k: string, v: unknown) => void; long: boolean; t: (k: MessageKey) => string }) {
  const v = form[f.key];
  const common = { id: `f-${f.key}`, required: f.required };
  switch (f.type) {
    case "bool": return <input type="checkbox" checked={!!v} onChange={(e) => set(f.key, e.target.checked)} />;
    case "int": case "num": return <input {...common} type="number" step={f.type === "int" ? 1 : "any"} min={f.min} max={f.max} value={String(v ?? "")} onChange={(e) => set(f.key, e.target.value)} />;
    case "date": return <input {...common} type="date" value={String(v ?? "")} onChange={(e) => set(f.key, e.target.value)} />;
    case "time": return <input {...common} type="time" value={String(v ?? "").slice(0, 5)} onChange={(e) => set(f.key, e.target.value)} />;
    case "ts": return <input {...common} type="datetime-local" value={String(v ?? "")} onChange={(e) => set(f.key, e.target.value)} />;
    case "enum": return (
      <select {...common} value={String(v ?? "")} onChange={(e) => set(f.key, e.target.value)}>
        {!f.required && <option value="">—</option>}
        {f.values!.map((x) => <option key={x} value={x}>{choice(t, x)}</option>)}
      </select>
    );
    case "ref": return <RefSelect f={f} value={v} onChange={(x) => set(f.key, x)} owner={form.ownerKind} t={t} />;
    case "tags":
      if (f.key === "avoid") {
        const cur = (Array.isArray(v) ? v : []) as string[];
        return <div className="row">{AVOIDS.map((a) => <label key={a} className="row" style={{ gap: 4 }}><input type="checkbox" checked={cur.includes(a)} onChange={(e) => set(f.key, e.target.checked ? [...cur, a] : cur.filter((x) => x !== a))} />{choice(t, a)}</label>)}</div>;
      }
      return <input {...common} value={Array.isArray(v) ? v.join(", ") : String(v ?? "")} placeholder={t("rCommaList")} onChange={(e) => set(f.key, e.target.value)} />;
    case "json": return <textarea {...common} rows={4} spellCheck={false} placeholder={t("rJsonHint")} value={typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 1)} onChange={(e) => set(f.key, e.target.value)} />;
    default:
      if (f.key === "photoDataUrl") return <PhotoInput value={String(v ?? "")} onChange={(x) => set(f.key, x)} />;
      return long ? <textarea {...common} rows={3} maxLength={f.max} value={String(v ?? "")} onChange={(e) => set(f.key, e.target.value)} /> : <input {...common} maxLength={f.max} value={String(v ?? "")} onChange={(e) => set(f.key, e.target.value)} />;
  }
}

/** Pick a photo; it is shrunk in the browser and kept as a small data URL. */
function PhotoInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="row">
      {value && <img src={value} alt="" width={64} height={64} style={{ objectFit: "cover", borderRadius: 8 }} />}
      <input type="file" accept="image/*" capture="environment" onChange={async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const small = await downscaleImage(file, 480, 0.75);
        const url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(small); });
        onChange(url);
      }} />
    </div>
  );
}

const CUSTOM_ENTITY: Record<string, "job" | "vehicle" | "depot" | undefined> = { vehicles: "vehicle", depots: "depot", jobs: "job" };

/** Files on a record: list, add, open. Shown when editing a record that supports them. */
function Attachments({ kind, id }: { kind: string; id: string }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const files = useApi<{ id: string; name: string; contentType: string }[]>(`/attachments/of/${kind}/${id}`);
  const input = useRef<HTMLInputElement>(null);
  async function open(fid: string) {
    const s = loadSession();
    const res = await fetch(`${API_URL}/attachments/${fid}`, { headers: { Authorization: `Bearer ${s?.token}` } });
    if (res.ok) window.open(URL.createObjectURL(await res.blob()), "_blank", "noopener");
  }
  async function add(file: File) {
    const s = loadSession();
    const body = file.type.startsWith("image/") ? await downscaleImage(file) : file;
    const res = await fetch(`${API_URL}/attachments/for/${kind}/${id}?name=${encodeURIComponent(file.name)}`, { method: "PUT", headers: { Authorization: `Bearer ${s?.token}`, "content-type": body.type || file.type }, body });
    if (res.ok) { toast(t("rUploaded")); files.reload(); } else toast(t("saveFailed"), { tone: "error" });
  }
  return (
    <div className="stack" style={{ gap: 6 }}>
      <strong>{t("rAttachments")}</strong>
      <div className="row">
        {(files.data ?? []).map((f) => <button key={f.id} type="button" className="btn sm alt" onClick={() => open(f.id)}><Paperclip size={14} aria-hidden />{f.name}</button>)}
        <button type="button" className="btn sm ghost" onClick={() => input.current?.click()}><Plus size={14} aria-hidden />{t("rAddFile")} ({t("rPhotoOrPdf")})</button>
        <input ref={input} type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void add(f); e.target.value = ""; }} />
      </div>
    </div>
  );
}

export default function ResourcePage({ name, extra, onOpen, embedded }: { name: string; extra?: ReactNode; onOpen?: (r: Row) => void; embedded?: boolean }) {
  const { t, locale } = useI18n();
  const { toast, undoable } = useToast();
  const { can } = useMe();
  const schemas = useApi<ResourceSchema[]>("/r/_schema");
  const schema = schemas.data?.find((s) => s.name === name);
  const view = RESOURCE_VIEWS[name];
  const rows = useApi<Row[]>(schema ? `/r/${name}?limit=1000` : null);
  type RefList = { id: string; name: string }[];
  const refs: { vehicles: RefList; drivers: RefList; depots: RefList } & Record<string, RefList> = {
    teams: useRefOptions("teams", !!schema?.fields.some((f) => f.ref === "teams")),
    "rate-cards": useRefOptions("rate-cards", !!schema?.fields.some((f) => f.ref === "rate-cards")),
    vehicles: useRefOptions("vehicles", !!schema?.fields.some((f) => f.ref === "vehicles" || f.ref === "@owner")),
    drivers: useRefOptions("drivers", !!schema?.fields.some((f) => f.ref === "drivers" || f.ref === "@owner")),
    depots: useRefOptions("depots", !!schema?.fields.some((f) => f.ref === "depots")),
  };
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id?: string; form: Record<string, unknown> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setEditing(null), [name]);

  const fmt = (f: FieldSchema, v: unknown): ReactNode => {
    if (v === null || v === undefined || v === "") return "—";
    switch (f.type) {
      case "bool": return v ? <Chip tone="warn">{t("rYes")}</Chip> : t("rNo");
      case "enum": return <Chip tone={["urgent", "major", "overdue", "failed", "cancelled"].includes(String(v)) ? "danger" : ["done", "active", "available", "closed"].includes(String(v)) ? "ok" : undefined}>{choice(t, String(v))}</Chip>;
      case "ts": return new Date(String(v)).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "medium", timeStyle: "short" });
      case "ref": { const list = refs[f.ref === "@owner" ? (undefined as never) : f.ref!] ?? []; return list.find((o) => o.id === v)?.name ?? "…"; }
      case "tags": return (v as string[]).join(", ");
      case "json": return Array.isArray(v) ? `${v.length}` : "{…}";
      default: return String(v);
    }
  };

  const columns: Column<Row>[] = useMemo(() => {
    if (!schema || !view) return [];
    return view.columns.map((k) => schema.fields.find((f) => f.key === k)).filter((f): f is FieldSchema => !!f).map((f) => ({
      key: f.key, header: label(t, f.key), width: f.type === "text" ? 200 : 130, numeric: f.type === "int" || f.type === "num",
      value: (r: Row) => (f.type === "enum" && r[f.key] ? choice(t, String(r[f.key])) : (r[f.key] as never)),
      render: (r: Row) => (f.key === "ownerId" ? (refs.vehicles.find((o) => o.id === r.ownerId) ?? refs.drivers.find((o) => o.id === r.ownerId))?.name ?? "—" : fmt(f, r[f.key])),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, view, t, refs.vehicles.length, refs.drivers.length, refs.depots.length, refs.teams?.length, refs["rate-cards"]?.length, locale]);

  if (!view) return <div className="content"><ErrorState error={new Error("404")} /></div>;
  const canWrite = !!schema?.canWrite;
  const hide = new Set([...(view.hideInForm ?? []), "id"]);

  function startEdit(r?: Row) {
    const form: Record<string, unknown> = {};
    for (const f of schema!.fields) {
      const v = r?.[f.key];
      form[f.key] = f.type === "ts" ? isoToLocalInput(v as string) : f.type === "json" ? (v == null ? "" : JSON.stringify(v)) : f.type === "enum" && !r ? (f.required ? f.values![0] : "") : v ?? (f.type === "bool" ? false : "");
    }
    if (!r && name === "jobs") form.type = "delivery";
    if (!r && name === "vehicles") { form.kind = "truck"; form.status = "active"; }
    setEditing({ id: r?.id, form });
    setError(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const body = formToBody(schema!.fields, editing.form, [...hide], !editing.id);
      if (editing.id) await apiSend("PATCH", `/r/${name}/${editing.id}`, body); else await apiSend("POST", `/r/${name}`, body);
      toast(t("rSaved"));
      setEditing(null);
      rows.reload();
    } catch (err) {
      setError(err instanceof SyntaxError ? "JSON" : (err as Error).message);
    } finally { setSaving(false); }
  }

  function remove(r: Row) {
    undoable(t("rDeleted"), {
      hide: () => { setHidden((s) => new Set(s).add(r.id)); },
      restore: () => setHidden((s) => { const n = new Set(s); n.delete(r.id); return n; }),
      commit: async () => { await apiSend("DELETE", `/r/${name}/${r.id}`); rows.reload(); },
    });
  }

  const data = (rows.data ?? []).filter((r) => !hidden.has(r.id));
  const title = t(`res_${name}` as MessageKey);
  const withActions: Column<Row>[] = canWrite ? [...columns, {
    key: "_actions", header: t("actions"), width: 96, value: () => "", noGroup: true,
    render: (r) => (
      <span className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn sm ghost" aria-label={`${t("rEdit")} ${title}`} onClick={() => startEdit(r)}><Pencil size={14} aria-hidden /></button>
        <button type="button" className="btn sm ghost" aria-label={t("rDelete")} onClick={() => remove(r)}><Trash2 size={14} aria-hidden /></button>
      </span>
    ),
  }] : columns;

  return (
    <div className={embedded ? "stack" : "content"}>
      {embedded && <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>{canWrite && <button type="button" className="btn" onClick={() => startEdit()} disabled={!schema}><Plus size={16} aria-hidden />{t("rNew")}</button>}</div>}
      {!embedded && <PageHead
        title={title}
        subtitle={!canWrite && schema ? t("rNoAccess") : undefined}
        actions={<>
          {can("reports.export") && <a className="btn alt" href="#export" onClick={async (e) => {
            e.preventDefault();
            const s = loadSession();
            const res = await fetch(`${API_URL}/r/${name}?format=csv`, { headers: { Authorization: `Bearer ${s?.token}` } });
            if (res.ok) { const a = document.createElement("a"); a.href = URL.createObjectURL(await res.blob()); a.download = `${name}.csv`; a.click(); }
          }}><Download size={16} aria-hidden />{t("rExport")}</a>}
          {canWrite && <button type="button" className="btn" onClick={() => startEdit()} disabled={!schema}><Plus size={16} aria-hidden />{t("rNew")}</button>}
        </>}
      />}
      {extra}
      {(schemas.loading && !schemas.loaded) || (!rows.loaded && !rows.error && schema) ? <SkeletonList rows={6} h={38} /> : null}
      {(schemas.error || rows.error) && !rows.loaded && <ErrorState error={schemas.error ?? rows.error} onRetry={() => { schemas.reload(); rows.reload(); }} />}
      {schemas.loaded && !schema && <ErrorState forbidden />}
      {rows.loaded && data.length === 0 && <EmptyState title={t("rEmpty")} action={canWrite ? <button type="button" className="btn" onClick={() => startEdit()}>{t("rNew")}</button> : undefined} />}
      {rows.loaded && data.length > 0 && (
        <DataTable tableId={`res-${name}`} columns={withActions} rows={data} rowKey={(r) => r.id} csvName={name} onRowClick={onOpen ?? (canWrite ? startEdit : undefined)} />
      )}

      <Modal
        open={!!editing} onClose={() => setEditing(null)} title={`${editing?.id ? t("rEdit") : t("rNew")} · ${title}`}
        actions={<><button type="button" className="btn alt" onClick={() => setEditing(null)}>{t("cancel")}</button><button type="submit" form="res-form" className="btn" disabled={saving}>{t("save")}</button></>}
      >
        {editing && schema && (
          <form id="res-form" className="stack" onSubmit={save}>
            {schema.fields.filter((f) => !hide.has(f.key)).map((f) => (
              <label key={f.key} className="field" htmlFor={`f-${f.key}`}>
                <span>{label(t, f.key)}{f.required && <span aria-hidden> *</span>}</span>
                <FieldInput f={f} form={editing.form} set={(k, v) => setEditing((s) => s && { ...s, form: { ...s.form, [k]: v } })} long={!!view.longText?.includes(f.key)} t={t} />
              </label>
            ))}
            {name === "rate-cards" && <BandsEditor basis={String(editing.form.basis ?? "distance")} tiers={editing.form.tiers} zones={editing.form.zones} onTiers={(v) => setEditing((s) => s && { ...s, form: { ...s.form, tiers: v } })} onZones={(v) => setEditing((s) => s && { ...s, form: { ...s.form, zones: v } })} />}
            {name === "route-templates" && <RecurrenceEditor value={editing.form.recurrence} onChange={(v) => setEditing((s) => s && { ...s, form: { ...s.form, recurrence: v } })} />}
            {editing.id && view.attach && <Attachments kind={view.attach} id={editing.id} />}
            {editing.id && CUSTOM_ENTITY[name] && <CustomFieldsPanel entity={CUSTOM_ENTITY[name]!} recordId={editing.id} />}
            {error && <div className="err" role="alert">{error}</div>}
          </form>
        )}
      </Modal>
    </div>
  );
}

/** Simple repeat rule: none, daily, or weekly on chosen weekdays. */
function RecurrenceEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useI18n();
  const parsed = (() => { try { return typeof value === "string" ? (value ? JSON.parse(value) : null) : (value as { every?: string; days?: number[]; interval?: number; from?: string; until?: string } | null); } catch { return null; } })();
  const every = parsed?.every ?? "";
  const set = (patch: Record<string, unknown>) => onChange(JSON.stringify({ ...(parsed ?? { every: "day" }), ...patch }));
  const dayNames = [1, 2, 3, 4, 5, 6, 7].map((d) => new Date(Date.UTC(2024, 0, d)).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }));
  return (
    <fieldset className="stack" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
      <legend>{t("f_recurrence")}</legend>
      <select aria-label={t("f_recurrence")} value={every} onChange={(e) => onChange(e.target.value ? JSON.stringify({ ...(parsed ?? {}), every: e.target.value }) : "")}>
        <option value="">{t("rNone")}</option><option value="day">{t("recDaily")}</option><option value="week">{t("recWeekly")}</option>
      </select>
      {every && <label className="field">{t("recEvery")}<input type="number" min={1} max={52} value={parsed?.interval ?? 1} onChange={(e) => set({ interval: Number(e.target.value) || 1 })} /></label>}
      {every === "week" && <div className="row">{dayNames.map((n, i) => {
        const d = i + 1; const cur = parsed?.days ?? [];
        return <label key={d} className="row" style={{ gap: 4 }}><input type="checkbox" checked={cur.includes(d)} onChange={(e) => set({ days: e.target.checked ? [...cur, d].sort() : cur.filter((x: number) => x !== d) })} />{n}</label>;
      })}</div>}
      {every && <div className="row"><label className="field">{t("recFrom")}<input type="date" value={parsed?.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} /></label>
        <label className="field">{t("recUntil")}<input type="date" value={parsed?.until ?? ""} onChange={(e) => set({ until: e.target.value || undefined })} /></label></div>}
    </fieldset>
  );
}
