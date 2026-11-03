"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import { DriverExtras } from "@/components/DriverExtras";
import { DriverSafety } from "@/components/DriverSafety";
import { DriverMore } from "@/components/DriverMore";
import { Sheet } from "@/components/DriverSheet";
import { LanguageToggle } from "@/components/LanguageToggle";
import { SignaturePad, type SignaturePadHandle } from "@/components/SignaturePad";
import { navigationLinks, nextStopIndex } from "@/lib/driver-nav";
import { newId, queueStore, syncNow } from "@/lib/driver-sync";
import { downscaleImage } from "@/lib/image";
import { useI18n } from "@/lib/i18n-context";
import { applyPending, type DriverRoute, type DriverStop, type QueueItem, type StatusBody } from "@/lib/offline-queue";
import { usePullToRefresh } from "@/lib/pull-refresh";
import { API_URL, loadSession, saveSession } from "@/lib/session";

interface Stop extends DriverStop { name: string; address: string | null; lat: number; lng: number; sequence: number; notes: string | null; packages: number | null; customerInstructions?: string | null }
interface Route extends DriverRoute { name: string; stops: Stop[] }

const CACHE_KEY = "routenorth.driver.routes";
const REASONS = ["nobody", "refused", "address", "closed", "other"] as const;

function loadCache(): Route[] {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "[]") as Route[]; } catch { return []; }
}

/** Best-effort position for a proof; never blocks the driver for more than a moment. */
function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { timeout: 3000, maximumAge: 60_000 },
    );
  });
}

export default function DriverPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [base, setBase] = useState<Route[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [online, setOnline] = useState(true);
  const [sheet, setSheet] = useState<{ kind: "complete" | "fail"; stop: Stop } | null>(null);
  const [dropped, setDropped] = useState(false);
  const position = useRef<{ lat: number; lng: number } | null>(null);

  const refreshQueue = useCallback(async () => { setQueue(await queueStore.all().catch(() => [])); }, []);

  const logout = useCallback(() => { saveSession(null); router.replace("/login"); }, [router]);

  const refreshRoutes = useCallback(async () => {
    const s = loadSession();
    if (!s) return;
    try {
      const res = await fetch(`${API_URL}/driver/routes`, { headers: { Authorization: `Bearer ${s.token}` } });
      if (res.status === 401) return logout();
      if (!res.ok) return;
      const data = (await res.json()) as Route[];
      setBase(data);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* cache is optional */ }
    } catch { /* offline: keep showing the cached routes */ }
  }, [logout]);

  const sync = useCallback(async () => {
    const out = await syncNow();
    if (out.stoppedBy === "auth") return logout();
    if (out.failed > 0) setDropped(true);
    await refreshQueue();
    if (out.sent > 0 || out.stoppedBy === null) await refreshRoutes();
  }, [logout, refreshQueue, refreshRoutes]);

  useEffect(() => {
    const s = loadSession();
    if (!s) { router.replace("/login"); return; }
    if (s.role && s.role !== "driver") { router.replace("/"); return; }
    setBase(loadCache());
    setOnline(navigator.onLine);
    setReady(true);
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => { /* the app still works without offline caching */ });
    }
    void refreshQueue().then(sync);
    const up = () => { setOnline(true); void sync(); };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const timer = setInterval(() => { void sync(); }, 30_000);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); clearInterval(timer); };
  }, [router, refreshQueue, sync]);

  async function enqueue(items: QueueItem[]) {
    for (const i of items) await queueStore.put(i);
    await refreshQueue();
    void sync();
  }

  const status = (stop: Stop, body: Omit<StatusBody, "occurredAt">): QueueItem => ({
    id: newId(), kind: "status", stopId: stop.id, body: { ...body, occurredAt: new Date().toISOString() },
  });

  const refresher = usePullToRefresh(sync, ready);

  if (!ready) return null;
  const routes = applyPending(base, queue);
  const pending = queue.filter((q) => !q.failed).length;

  return (
    <main className="driver">
      <div className="pull-indicator" style={{ height: refresher.busy ? 36 : refresher.pull }} role="status" aria-live="polite">
        {(refresher.busy || refresher.pull > 0) && <span>{refresher.busy ? t("pull_refreshing") : refresher.ready ? t("pull_release") : t("pull_pull")}</span>}
      </div>
      <header className="driver-bar">
        <strong>{t("driverToday")}</strong>
        <span className={online ? "pill ok" : "pill warn"} role="status">{online ? t("online") : t("offline")}</span>
        <LanguageToggle />
        <button type="button" className="link" onClick={logout}>{t("signOut")}</button>
      </header>

      {pending > 0 && (
        <div className="sync-note" role="status">
          {pending} {t("pendingSync")}
          {online && <button type="button" onClick={() => void sync()}>{t("syncNow")}</button>}
        </div>
      )}
      {dropped && (
        <p className="error" role="alert">
          {t("syncProblems")} <button type="button" className="link" onClick={() => setDropped(false)}>{t("closeSheet")}</button>
        </p>
      )}

      {routes.length === 0 && <p className="empty">{t("noRouteToday")}</p>}
      {routes.map((route) => {
        const next = nextStopIndex(route.stops);
        return (
          <section key={route.id} aria-label={route.name}>
            <h1 className="h">{route.name}</h1>
            <ol className="driver-stops">
              {route.stops.map((s, i) => (
                <StopCard
                  key={s.id} stop={s} isNext={i === next} t={t}
                  onArrive={() => void enqueue([status(s, { status: "arrived" })])}
                  onComplete={() => { position.current = null; void currentPosition().then((p) => { position.current = p; }); setSheet({ kind: "complete", stop: s }); }}
                  onFail={() => setSheet({ kind: "fail", stop: s })}
                  onSkip={() => void enqueue([status(s, { status: "skipped", reason: "Skipped by driver" })])}
                />
              ))}
            </ol>
          </section>
        );
      })}
      <DriverExtras nextStop={(() => { const r = routes[0]; if (!r) return null; const i = nextStopIndex(r.stops); const st = r.stops[i]; return st ? { id: st.id, name: st.name } : null; })()} />
      <DriverMore
        nextStop={(() => { const r = routes[0]; if (!r) return null; const st = r.stops[nextStopIndex(r.stops)]; return st ? { id: st.id, name: st.name, address: st.address } : null; })()}
        actions={{
          arrive: () => { const st = routes[0]?.stops[nextStopIndex(routes[0].stops)]; if (st && st.status === "pending") void enqueue([status(st, { status: "arrived" })]); },
          complete: () => { const st = routes[0]?.stops[nextStopIndex(routes[0].stops)]; if (st) { position.current = null; void currentPosition().then((p) => { position.current = p; }); setSheet({ kind: "complete", stop: st }); } },
          fail: () => { const st = routes[0]?.stops[nextStopIndex(routes[0].stops)]; if (st) setSheet({ kind: "fail", stop: st }); },
          navigate: () => { const st = routes[0]?.stops[nextStopIndex(routes[0].stops)]; if (st) window.open(navigationLinks(st.lat, st.lng).google, "_blank", "noopener"); },
        }}
      />
      <DriverSafety />
      <p className="meta">{t("installHint")}</p>

      {sheet?.kind === "complete" && (
        <CompleteSheet
          stop={sheet.stop} t={t} onClose={() => setSheet(null)}
          onSubmit={async (d) => {
            const items: QueueItem[] = [];
            const where = position.current ?? {}; // fetched when the sheet opened, so offline submits don't wait
            const takenAt = new Date().toISOString();
            if (d.photo) items.push({ id: newId(), kind: "proof", stopId: sheet.stop.id, clientId: newId(), proofKind: "photo", takenAt, contentType: d.photo.type || "image/jpeg", data: d.photo, ...where });
            if (d.signature) items.push({ id: newId(), kind: "proof", stopId: sheet.stop.id, clientId: newId(), proofKind: "signature", takenAt, contentType: "image/png", data: d.signature, ...where });
            items.push(status(sheet.stop, { status: "done", recipientName: d.receivedBy || undefined, notes: d.notes || undefined }));
            setSheet(null);
            await enqueue(items);
          }}
        />
      )}
      {sheet?.kind === "fail" && (
        <FailSheet
          stop={sheet.stop} t={t} onClose={() => setSheet(null)}
          onSubmit={async (d) => {
            setSheet(null);
            await enqueue([status(sheet.stop, { status: "failed", reason: d.reason, notes: d.notes || undefined })]);
          }}
        />
      )}
    </main>
  );
}

type T = (k: MessageKey) => string;

function StopCard(props: {
  stop: Stop; isNext: boolean; t: T;
  onArrive: () => void; onComplete: () => void; onFail: () => void; onSkip: () => void;
}) {
  const { stop: s, isNext, t } = props;
  const open = s.status === "pending" || s.status === "arrived";
  const links = navigationLinks(s.lat, s.lng);
  return (
    <li className={`driver-stop${isNext ? " next" : ""}${open ? "" : " finished"}`} aria-current={isNext ? "step" : undefined}>
      <div className="stop-head">
        <span className="num" style={{ background: "var(--brand)" }} aria-hidden>{s.sequence}</span>
        <strong>{s.name}</strong>
        <span className="meta">{isNext && `${t("nextStop")} · `}{t(`status_${s.status}` as MessageKey)}</span>
      </div>
      {s.address && <p className="meta">{s.address}</p>}
      {s.notes && <p className="meta">{s.notes}</p>}
      {s.customerInstructions && <p className="meta"><strong>{t("dx_customerNote")}:</strong> {s.customerInstructions}</p>}
      {s.packages ? <p className="meta">{s.packages} pkg</p> : null}
      {s.failureReason && <p className="meta">{s.failureReason}</p>}
      {open && (
        <>
          <div className="nav-links" role="group" aria-label={t("navigate")}>
            <a className="btn" href={links.google} target="_blank" rel="noreferrer">{t("googleMaps")}</a>
            <a className="btn alt" href={links.apple} target="_blank" rel="noreferrer">{t("appleMaps")}</a>
            <a className="btn alt" href={links.waze} target="_blank" rel="noreferrer">{t("waze")}</a>
          </div>
          <div className="big-actions">
            {s.status === "pending" && <button type="button" onClick={props.onArrive}>{t("imHere")}</button>}
            <button type="button" className="primary" onClick={props.onComplete}>{t("completeStop")}</button>
            <button type="button" onClick={props.onFail}>{t("cantDeliver")}</button>
            <button type="button" className="link" onClick={props.onSkip}>{t("skipStop")}</button>
          </div>
        </>
      )}
      {!open && s.proofCount > 0 && <p className="meta">{t("proofs")}: {s.proofCount}</p>}
    </li>
  );
}

function CompleteSheet(props: {
  stop: Stop; t: T; onClose: () => void;
  onSubmit: (d: { photo: Blob | null; signature: Blob | null; receivedBy: string; notes: string }) => Promise<void>;
}) {
  const { t } = props;
  const pad = useRef<SignaturePadHandle>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  return (
    <Sheet title={`${t("completeStop")}: ${props.stop.name}`} t={t} onClose={props.onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const f = new FormData(e.currentTarget);
          const signature = pad.current && !pad.current.isEmpty() ? await pad.current.toBlob() : null;
          await props.onSubmit({ photo, signature, receivedBy: String(f.get("receivedBy") ?? "").trim(), notes: String(f.get("notes") ?? "").trim() });
        }}
      >
        <label className="field">
          {photo ? t("retakePhoto") : t("takePhoto")}
          <input
            type="file" accept="image/*" capture="environment"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const small = await downscaleImage(file);
              setPhoto(small);
              setPreview(URL.createObjectURL(small));
            }}
          />
        </label>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {preview && <img src={preview} alt={t("photo")} className="proof-preview" />}
        <div className="field">
          {t("signature")}
          <SignaturePad ref={pad} label={t("signature")} />
          <button type="button" className="link" onClick={() => pad.current?.clear()}>{t("clearSignature")}</button>
        </div>
        <label className="field">{t("receivedBy")}<input name="receivedBy" autoComplete="off" maxLength={120} /></label>
        <label className="field">{t("notes")}<input name="notes" autoComplete="off" maxLength={1000} /></label>
        <button type="submit" className="primary" disabled={busy}>{t("confirm")}</button>
      </form>
    </Sheet>
  );
}

function FailSheet(props: { stop: Stop; t: T; onClose: () => void; onSubmit: (d: { reason: string; notes: string }) => Promise<void> }) {
  const { t } = props;
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title={`${t("cantDeliver")}: ${props.stop.name}`} t={t} onClose={props.onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const f = new FormData(e.currentTarget);
          // Store the English label so planners see one consistent vocabulary.
          const key = String(f.get("reason")) as (typeof REASONS)[number];
          await props.onSubmit({ reason: ENGLISH[key] ?? key, notes: String(f.get("notes") ?? "").trim() });
        }}
      >
        <label className="field">
          {t("reason")}
          <select name="reason" required defaultValue="nobody">
            {REASONS.map((r) => <option key={r} value={r}>{t(`reason_${r}` as MessageKey)}</option>)}
          </select>
        </label>
        <label className="field">{t("notes")}<input name="notes" autoComplete="off" maxLength={1000} /></label>
        <button type="submit" className="primary" disabled={busy}>{t("confirm")}</button>
      </form>
    </Sheet>
  );
}

const ENGLISH: Record<string, string> = {
  nobody: "Nobody home", refused: "Refused", address: "Wrong or missing address", closed: "Closed", other: "Other",
};
