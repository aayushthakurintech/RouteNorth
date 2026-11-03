"use client";
import { useEffect, useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import { Sheet } from "@/components/DriverSheet";
import { downscaleImage } from "@/lib/image";
import { useI18n } from "@/lib/i18n-context";
import { API_URL, loadSession } from "@/lib/session";

type T = (k: MessageKey, v?: Record<string, string | number>) => string;
const CHECKS = ["tires", "lights", "brakes", "mirrors", "wipers", "fluids", "horn", "seatbelts", "fireExtinguisher", "firstAid", "cargoSecure", "bodyDamage", "cleanliness"] as const;
const KINDS = ["accident", "near_miss", "theft", "damage", "breakdown", "other"] as const;
const SEVERITIES = ["minor", "moderate", "major"] as const;

async function call<R>(method: string, path: string, body?: unknown, raw?: Blob): Promise<R> {
  const s = loadSession();
  const headers: Record<string, string> = { Authorization: `Bearer ${s?.token}` };
  if (raw) headers["content-type"] = raw.type;
  else if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? `HTTP ${res.status}`);
  return res.status === 204 ? (undefined as R) : res.json();
}

const here = (): Promise<{ lat: number; lng: number } | null> =>
  new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), () => ok(null), { timeout: 4000, maximumAge: 60_000 });
  });

interface Vehicle { id: string; name: string; plate: string | null; odometerKm: number }

function VehicleCheck({ t, onClose, onDone }: { t: T; onClose: () => void; onDone: (m: string) => void }) {
  const [vehicle, setVehicle] = useState<Vehicle | null | undefined>(undefined);
  const [kind, setKind] = useState<"check_out" | "check_in">("check_out");
  const [bad, setBad] = useState<Record<string, string>>({});
  const [odo, setOdo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { call<Vehicle | null>("GET", "/driver/vehicle").then((v) => { setVehicle(v); if (v) setOdo(String(v.odometerKm ?? "")); }).catch(() => setVehicle(null)); }, []);
  return (
    <Sheet title={t("vc_title")} t={t} onClose={onClose}>
      {vehicle === undefined ? <p role="status">…</p> : vehicle === null ? <p>{t("vc_noVehicle")}</p> : (
        <form className="stack" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setErr(null);
          try {
            const r = await call<{ defects: boolean }>("POST", "/driver/inspections", {
              vehicleId: vehicle.id, kind, odometerKm: odo || undefined,
              items: CHECKS.map((k) => ({ key: k, ok: !(k in bad), note: bad[k] || undefined })),
            });
            onDone(r.defects ? t("vc_savedDefects") : t("vc_saved"));
          } catch (x) { setErr((x as Error).message); setBusy(false); }
        }}>
          <p><strong>{vehicle.name}</strong>{vehicle.plate ? ` · ${vehicle.plate}` : ""}</p>
          <div className="seg" role="group" aria-label={t("vc_title")}>
            <button type="button" aria-pressed={kind === "check_out"} onClick={() => setKind("check_out")}>{t("v_check_out")}</button>
            <button type="button" aria-pressed={kind === "check_in"} onClick={() => setKind("check_in")}>{t("v_check_in")}</button>
          </div>
          <label className="field">{t("f_odometerKm")}<input type="number" inputMode="numeric" min={0} value={odo} onChange={(e) => setOdo(e.target.value)} /></label>
          <fieldset className="stack"><legend>{t("vc_tick")}</legend>
            {CHECKS.map((k) => (
              <div key={k} className="stack">
                <label className="row"><input type="checkbox" checked={!(k in bad)} onChange={(e) => setBad((b) => { const n = { ...b }; if (e.target.checked) delete n[k]; else n[k] = ""; return n; })} />{t(`insp_${k}` as MessageKey)}</label>
                {k in bad && <input aria-label={t("vc_describe")} placeholder={t("vc_describe")} maxLength={300} value={bad[k]} onChange={(e) => setBad({ ...bad, [k]: e.target.value })} />}
              </div>
            ))}
          </fieldset>
          {err && <p className="error" role="alert">{err}</p>}
          <button type="submit" className="primary" disabled={busy}>{t("confirm")}</button>
        </form>
      )}
    </Sheet>
  );
}

function IncidentSheet({ t, onClose, onDone }: { t: T; onClose: () => void; onDone: (m: string) => void }) {
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [photos, setPhotos] = useState<Blob[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { call<Vehicle | null>("GET", "/driver/vehicle").then(setVehicle).catch(() => setVehicle(null)); }, []);
  return (
    <Sheet title={t("inc_title")} t={t} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null);
        const f = new FormData(e.currentTarget);
        try {
          const pos = await here();
          const r = await call<{ id: string }>("POST", "/driver/incidents", {
            kind: f.get("kind"), severity: f.get("severity"), description: String(f.get("description") ?? ""), injuries: f.get("injuries") === "on",
            location: String(f.get("location") ?? "") || undefined, vehicleId: vehicle?.id, ...(pos ?? {}),
          });
          for (const [i, p] of photos.entries()) await call("PUT", `/driver/incidents/${r.id}/photos?name=incident-${i + 1}.jpg`, undefined, p);
          onDone(t("inc_saved"));
        } catch (x) { setErr((x as Error).message); setBusy(false); }
      }}>
        <label className="field">{t("f_kind")}<select name="kind" defaultValue="accident">{KINDS.map((k) => <option key={k} value={k}>{t(`v_${k}` as MessageKey)}</option>)}</select></label>
        <label className="field">{t("f_severity")}<select name="severity" defaultValue="minor">{SEVERITIES.map((k) => <option key={k} value={k}>{t(`v_${k}` as MessageKey)}</option>)}</select></label>
        <label className="field">{t("f_description")}<textarea name="description" required maxLength={4000} rows={4} /></label>
        <label className="field">{t("f_location")}<input name="location" maxLength={300} /></label>
        <label className="row"><input type="checkbox" name="injuries" />{t("f_injuries")}</label>
        <label className="field">{t("inc_addPhoto")}<input type="file" accept="image/*" capture="environment" onChange={async (e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) { const small = await downscaleImage(file); setPhotos((p) => [...p, small]); } }} /></label>
        {photos.length > 0 && <p className="meta">{t("inc_photos", { n: photos.length })}</p>}
        {err && <p className="error" role="alert">{err}</p>}
        <button type="submit" className="primary" disabled={busy}>{t("confirm")}</button>
      </form>
    </Sheet>
  );
}

interface Detector { detect: (img: ImageBitmap) => Promise<{ rawValue: string }[]> }

function ScanSheet({ t, stop, onClose, onDone }: { t: T; stop: { id: string; name: string }; onClose: () => void; onDone: (m: string) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const supported = typeof window !== "undefined" && "BarcodeDetector" in window;
  async function fromPhoto(file: File) {
    try {
      const Ctor = (window as unknown as { BarcodeDetector: new () => Detector }).BarcodeDetector;
      const found = await new Ctor().detect(await createImageBitmap(file));
      if (found[0]) setCode(found[0].rawValue); else setErr(t("scan_none"));
    } catch { setErr(t("scan_none")); }
  }
  return (
    <Sheet title={`${t("scan_title")}: ${stop.name}`} t={t} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null);
        try {
          const r = await call<{ duplicate: boolean }>("POST", `/driver/stops/${stop.id}/scans`, { code: code.trim(), clientId: crypto.randomUUID(), scannedAt: new Date().toISOString() });
          onDone(r.duplicate ? t("scan_dup") : t("scan_saved"));
        } catch (x) { setErr((x as Error).message); setBusy(false); }
      }}>
        {supported && <label className="field">{t("scan_photo")}<input type="file" accept="image/*" capture="environment" onChange={(e) => { const f = e.target.files?.[0]; if (f) void fromPhoto(f); }} /></label>}
        <label className="field">{t("scan_code")}<input value={code} required maxLength={200} autoComplete="off" inputMode="text" onChange={(e) => setCode(e.target.value)} /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <button type="submit" className="primary" disabled={busy || !code.trim()}>{t("confirm")}</button>
      </form>
    </Sheet>
  );
}

interface MyNumbers { metrics: Record<string, number | null>; earnings: { hours: number; overtimeH: number; estimate: number } | null }
function MySheet({ t, onClose }: { t: T; onClose: () => void }) {
  const [d, setD] = useState<MyNumbers | null | undefined>(undefined);
  useEffect(() => { call<MyNumbers>("GET", "/analytics/me").then(setD).catch(() => setD(null)); }, []);
  const m = d?.metrics ?? {};
  const row = (label: MessageKey, v: number | null | undefined, suffix = "") => <div className="stat-row" key={label}><span>{t(label)}</span><strong>{v == null ? "—" : `${Math.round(v * 10) / 10}${suffix}`}</strong></div>;
  return (
    <Sheet title={t("dash_myNumbers")} t={t} onClose={onClose}>
      {d === undefined ? <p className="meta">…</p> : d === null ? <p className="error" role="alert">{t("error")}</p> : (
        <div className="stack">
          {row("an_driverScore", m.driverScore)}{row("an_stopsDone", m.stopsDone)}{row("an_onTimeRate", m.onTimeRate, "%")}{row("an_distanceKm", m.distanceKm, " km")}
          {row("an_speedingEvents", (m.speedingEvents ?? 0) + (m.harshBrakes ?? 0) + (m.harshAccels ?? 0))}
          {d.earnings && <div className="stat-row"><span>{t("dash_earnings")}</span><strong>{`$${d.earnings.estimate.toFixed(2)}`}</strong></div>}
          <p className="meta">{t("dash_earningsNote")}</p>
        </div>
      )}
    </Sheet>
  );
}

/** Extra driver tools: vehicle check, report a problem, scan a package code at the next stop. */
export function DriverExtras({ nextStop }: { nextStop: { id: string; name: string } | null }) {
  const { t } = useI18n() as { t: T };
  const [open, setOpen] = useState<"check" | "incident" | "scan" | "mine" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const done = (m: string) => { setOpen(null); setMsg(m); setTimeout(() => setMsg(null), 6000); };
  return (
    <section aria-label={t("drvx_tools")} className="stack">
      <div className="big-actions">
        <button type="button" onClick={() => setOpen("check")}>{t("vc_title")}</button>
        <button type="button" onClick={() => setOpen("incident")}>{t("inc_title")}</button>
        <button type="button" onClick={() => setOpen("mine")}>{t("dash_myNumbers")}</button>
        {nextStop && <button type="button" onClick={() => setOpen("scan")}>{t("scan_title")}</button>}
      </div>
      {msg && <p className="meta" role="status">{msg}</p>}
      {open === "check" && <VehicleCheck t={t} onClose={() => setOpen(null)} onDone={done} />}
      {open === "incident" && <IncidentSheet t={t} onClose={() => setOpen(null)} onDone={done} />}
      {open === "mine" && <MySheet t={t} onClose={() => setOpen(null)} />}
      {open === "scan" && nextStop && <ScanSheet t={t} stop={nextStop} onClose={() => setOpen(null)} onDone={done} />}
    </section>
  );
}
