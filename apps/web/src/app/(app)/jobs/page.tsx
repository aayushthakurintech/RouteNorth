"use client";
import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { JobPanel } from "@/components/JobPanel";
import ResourcePage from "@/components/ResourcePage";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";

/** Import jobs from a CSV file; rows without coordinates are looked up when address search is set up. */
function ImportJobs({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ created: number; needLocation: number[]; errors: { row: number; message: string }[] } | null>(null);
  async function pick(file: File) {
    try {
      const r = await apiSend<NonNullable<typeof result>>("POST", "/jobs/import", { csv: await file.text() });
      setResult(r);
      toast(t("jobsImported", { n: r.created }));
      onDone();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  return (
    <div className="stack" style={{ marginBlock: 8 }}>
      <div className="row">
        <button type="button" className="btn alt" onClick={() => input.current?.click()}><Upload size={16} aria-hidden />{t("jobsImport")}</button>
        <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ""; }} />
        <span className="meta">{t("jobsImportHelp")}</span>
      </div>
      {result && (result.errors.length > 0 || result.needLocation.length > 0) && (
        <div className="meta" role="status">
          {result.needLocation.length > 0 && <p>{t("jobsNeedLocation", { rows: result.needLocation.slice(0, 10).join(", ") })}</p>}
          {result.errors.slice(0, 8).map((e) => <p key={e.row} className="err">{t("rowError", { row: e.row })}: {e.message}</p>)}
        </div>
      )}
    </div>
  );
}

export default function JobsPage() {
  const { can } = useMe();
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  return (
    <>
      <ResourcePage key={tick} name="jobs" onOpen={(r) => setOpen(r.id)} extra={can("routes.write") ? <ImportJobs onDone={() => setTick((n) => n + 1)} /> : undefined} />
      {open && <JobPanel jobId={open} onClose={() => setOpen(null)} onChanged={() => setTick((n) => n + 1)} />}
    </>
  );
}
