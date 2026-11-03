"use client";
import { Inbox, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Chip, EmptyState, ErrorState, Kpi, Modal, PageHead, Skeleton, SuccessMark, Tabs, Tooltip } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { useTheme } from "@/lib/theme-context";
import { useToast } from "@/lib/toast";

const COLOR_TOKENS = ["--bg", "--surface", "--surface-2", "--line", "--fg", "--muted", "--brand", "--brand-soft", "--ok", "--warn", "--danger", "--info"];
const SPACES = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7"];
interface Demo { id: string; vehicle: string; team: string; km: number; status: string }
const ROWS: Demo[] = Array.from({ length: 24 }, (_, i) => ({ id: String(i), vehicle: `Truck ${i + 1}`, team: ["East", "West", "North"][i % 3]!, km: 40 + ((i * 37) % 300), status: ["moving", "idle", "stopped"][i % 3]! }));

/** The living style guide: every building block, in the current theme. If a screen needs something new, add it here first. */
export default function StyleGuide() {
  const { t } = useI18n();
  const { toast, undoable } = useToast();
  const { mode, setMode } = useTheme();
  const [tab, setTab] = useState("one");
  const [modal, setModal] = useState(false);
  const [rows, setRows] = useState(ROWS);
  const cols: Column<Demo>[] = [
    { key: "vehicle", header: "Vehicle", value: (r) => r.vehicle, width: 150, pinned: true, edit: (r, v) => setRows((l) => l.map((x) => (x.id === r.id ? { ...x, vehicle: v } : x))) },
    { key: "team", header: "Team", value: (r) => r.team, width: 120 },
    { key: "km", header: "Distance (km)", value: (r) => r.km, numeric: true, width: 140 },
    { key: "status", header: "Status", value: (r) => r.status, width: 140, render: (r) => <Chip tone={r.status === "moving" ? "ok" : r.status === "idle" ? "warn" : undefined} dot>{r.status}</Chip> },
  ];

  return (
    <div className="content">
      <PageHead title={t("styleGuide")} subtitle={t("styleGuideIntro")} actions={
        <div className="seg" role="group" aria-label={t("theme")}>
          {(["light", "dark", "contrast", "auto"] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{t(m === "light" ? "themeLight" : m === "dark" ? "themeDark" : m === "auto" ? "themeAuto" : "themeContrast")}</button>)}
        </div>
      } />

      <section className="card"><h2>Color tokens</h2>
        <div className="row" style={{ gap: 12 }}>{COLOR_TOKENS.map((c) => <div key={c} style={{ textAlign: "center", fontSize: 11.5 }}><div className="swatch" style={{ background: `var(${c})` }} /><code>{c.slice(2)}</code></div>)}</div>
        <h2>Chart palette (color-blind safe)</h2>
        <div className="row">{[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <div key={n} className="swatch" style={{ background: `var(--chart-${n})` }} title={`--chart-${n}`} />)}</div>
        <h2>Spacing (8-point grid)</h2>
        <div className="row" style={{ alignItems: "flex-end" }}>{SPACES.map((s) => <div key={s} style={{ textAlign: "center", fontSize: 11.5 }}><div style={{ width: `var(${s})`, height: `var(${s})`, background: "var(--brand)", margin: "0 auto" }} /><code>{s.slice(2)}</code></div>)}</div>
      </section>

      <section className="card"><h2>Type scale</h2>
        <div className="display" style={{ fontSize: "var(--fs-display)", fontWeight: 700 }}>Display 32 — Manrope</div>
        <div className="display" style={{ fontSize: "var(--fs-title)", fontWeight: 700 }}>Title 24</div>
        <div className="display" style={{ fontSize: "var(--fs-heading)", fontWeight: 700 }}>Heading 18</div>
        <div>Body 14.5 — Inter. The quick brown fox jumps over the lazy dog. 0123456789</div>
        <div className="meta">Caption 12.5 — secondary text</div>
      </section>

      <section className="card"><h2>Buttons, chips, switches</h2>
        <div className="row">
          <button className="btn" type="button"><Plus size={16} />Primary</button><button className="btn alt" type="button">Secondary</button>
          <button className="btn ghost" type="button">Ghost</button><button className="btn danger" type="button"><Trash2 size={16} />Danger</button><button className="btn" type="button" disabled>Disabled</button>
          <Tooltip text="Tooltips show on hover and focus"><button className="btn alt" type="button">Hover me</button></Tooltip>
        </div>
        <div className="row"><Chip>Neutral</Chip><Chip tone="ok" dot>Success</Chip><Chip tone="warn" dot>Warning</Chip><Chip tone="danger" dot>Danger</Chip><Chip tone="info">Info</Chip><Chip tone="brand">Brand</Chip></div>
        <label className="check"><input className="switch" type="checkbox" defaultChecked /> Switch</label>
      </section>

      <section className="card"><h2>Key numbers</h2>
        <div className="kpi-row">
          <Kpi label="On-time rate" value={94.2} format={(n) => `${n.toFixed(1)}%`} delta={0.021} sub="vs last week" />
          <Kpi label="Idle time" value={312} format={(n) => `${Math.round(n)} min`} delta={0.08} upIsGood={false} sub="vs last week" />
          <Kpi label="Stops per hour" value={4.6} format={(n) => n.toFixed(1)} />
          <Kpi label="No data yet" value={null} />
        </div>
      </section>

      <section className="card"><h2>Forms, tabs, dialogs, feedback</h2>
        <div className="form-grid"><label className="field">Label<input placeholder="Text" /><span className="hint">Helper text sits under the field.</span></label>
          <label className="field">Select<select><option>One</option><option>Two</option></select></label></div>
        <Tabs label="Demo tabs" value={tab} onChange={setTab} tabs={[{ id: "one", label: "One" }, { id: "two", label: "Two" }, { id: "three", label: "Three" }]} />
        <div className="row">
          <button className="btn alt" type="button" onClick={() => setModal(true)}>Open dialog</button>
          <button className="btn alt" type="button" onClick={() => toast("Saved")}>Toast</button>
          <button className="btn alt" type="button" onClick={() => toast("Something went wrong", { tone: "error" })}>Error toast</button>
          <button className="btn alt" type="button" onClick={() => { const keep = rows; undoable("Row deleted", { hide: () => setRows((l) => l.slice(1)), restore: () => setRows(keep), commit: () => undefined }); }}>Delete with undo</button>
          <SuccessMark label="Done" />
        </div>
        <Modal open={modal} onClose={() => setModal(false)} title="A dialog"><p style={{ margin: 0 }}>Focus is trapped, Escape closes it, and a click outside closes it.</p></Modal>
      </section>

      <section className="card"><h2>Loading, empty and error states</h2>
        <div className="grid cols-3">
          <div className="stack"><Skeleton h={18} w="60%" /><Skeleton h={44} /><Skeleton h={44} /></div>
          <EmptyState icon={<Inbox size={36} />} title="Nothing here yet" body="Say what to do next, and give a button for it." action={<button className="btn" type="button">Add the first one</button>} />
          <ErrorState onRetry={() => toast("Retrying…")} />
        </div>
      </section>

      <section className="stack"><h2>Smart table</h2>
        <DataTable tableId="styleguide" columns={cols} rows={rows} rowKey={(r) => r.id} maxHeight="320px" />
      </section>
    </div>
  );
}
