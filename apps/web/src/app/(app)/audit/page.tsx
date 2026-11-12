"use client";
import { Download } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState, ErrorState, PageHead, SkeletonList } from "@/components/ui/primitives";
import { apiGet } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { API_URL, loadSession } from "@/lib/session";

interface Row { id: string; at: string; actor: string | null; action: string; entity: string | null; entityId: string | null; method: string | null; path: string | null; status: number | null; detail: unknown; ip: string | null }
const PAGE = 100;

export default function AuditPage() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const [rows, setRows] = useState<Row[]>([]);
  const [actor, setActor] = useState("");
  const [text, setText] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [more, setMore] = useState(false);

  const query = useMemo(() => {
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (actor) p.set("actor", actor);
    if (text) p.set("q", text);
    return p;
  }, [actor, text]);

  const load = useCallback(async (append: boolean) => {
    try {
      const p = new URLSearchParams(query);
      if (append && rows.length) p.set("before", rows[rows.length - 1]!.at);
      const got = await apiGet<Row[]>(`/audit?${p}`);
      setRows((r) => (append ? [...r, ...got] : got));
      setMore(got.length === PAGE);
      setState("ready");
    } catch { setState("error"); }
  }, [query, rows]);

  useEffect(() => {
    const id = setTimeout(() => { setState("loading"); void load(false); }, 250);
    return () => clearTimeout(id);
  }, [actor, text]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = (iso: string) => new Date(iso).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA");
  const cols: Column<Row>[] = useMemo(() => [
    { key: "at", header: t("auditWhen"), value: (r) => r.at, render: (r) => fmt(r.at), width: 170, pinned: true },
    { key: "actor", header: t("auditWho"), value: (r) => r.actor, width: 200 },
    { key: "action", header: t("auditWhat"), value: (r) => r.action, width: 220 },
    { key: "entity", header: "Entity", value: (r) => r.entity, width: 110 },
    { key: "status", header: "HTTP", value: (r) => r.status, numeric: true, width: 80 },
    { key: "detail", header: t("auditDetail"), value: (r) => (r.detail ? JSON.stringify(r.detail) : ""), width: 420, noGroup: true },
    { key: "ip", header: t("auditFrom"), value: (r) => r.ip, width: 150, hidden: true },
  ], [t, locale]); // eslint-disable-line react-hooks/exhaustive-deps

  async function exportAll() {
    const p = new URLSearchParams(query); p.set("format", "csv"); p.set("limit", "5000");
    const res = await fetch(`${API_URL}/audit?${p}`, { headers: { Authorization: `Bearer ${loadSession()?.token}` } });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a"); a.href = url; a.download = "audit-log.csv"; a.click(); URL.revokeObjectURL(url);
  }

  if (!can("audit.view")) return <div className="content"><ErrorState forbidden /></div>;
  return (
    <div className="content wide">
      <PageHead title={t("auditTitle")} subtitle={t("auditSubtitle")} actions={<button type="button" className="btn alt" onClick={exportAll}><Download size={16} aria-hidden />{t("auditExport")}</button>} />
      <div className="row">
        <label className="field">{t("auditFilterActor")}<input type="search" value={actor} onChange={(e) => setActor(e.target.value)} /></label>
        <label className="field">{t("auditFilterText")}<input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="routes.create" /></label>
      </div>
      {state === "loading" && rows.length === 0 && <SkeletonList rows={6} h={38} />}
      {state === "error" && <ErrorState onRetry={() => void load(false)} />}
      {state === "ready" && (
        <>
          <DataTable tableId="audit" columns={cols} rows={rows} rowKey={(r) => r.id} empty={<EmptyState title={t("auditEmpty")} />} />
          {more && <button type="button" className="btn alt" style={{ alignSelf: "center" }} onClick={() => void load(true)}>{t("auditLoadMore")}</button>}
        </>
      )}
    </div>
  );
}
