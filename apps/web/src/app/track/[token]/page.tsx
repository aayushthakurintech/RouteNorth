"use client";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import { LanguageToggle } from "@/components/LanguageToggle";
import type { TrackData } from "@/components/TrackMap";
import { useI18n } from "@/lib/i18n-context";
import { API_URL } from "@/lib/session";

const TrackMap = dynamic(() => import("@/components/TrackMap").then((m) => m.TrackMap), { ssr: false });

interface Track extends TrackData {
  label: string | null; expiresAt: string;
  org: { name: string; color: string | null; logo: string | null };
  vehicle: { name: string; lat: number; lng: number; heading: number; speed: number; time: string; status: string } | null;
  stops: { name: string; lat: number | null; lng: number | null; status: string; eta: string | null; sequence: number }[];
}

/** After the last stop, the customer can rate the delivery: 1 to 5 stars and how likely they are to recommend (0 to 10). */
function Feedback({ token }: { token: string }) {
  const { t } = useI18n();
  const [csat, setCsat] = useState(0);
  const [nps, setNps] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [state, setState] = useState<"form" | "sent" | "error">("form");
  async function send(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await fetch(`${API_URL}/public/track/${encodeURIComponent(token)}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ csat: csat || undefined, nps: nps ?? undefined, comment }) });
      setState(r.ok ? "sent" : "error");
    } catch { setState("error"); }
  }
  if (state === "sent") return <p className="track-note" role="status">{t("fb_thanks")}</p>;
  return (
    <form onSubmit={send} className="feedback-form" aria-label={t("fb_title")}>
      <h2>{t("fb_title")}</h2>
      <fieldset><legend>{t("fb_howWas")}</legend>
        <div className="stars" role="radiogroup" aria-label={t("fb_howWas")}>
          {[1, 2, 3, 4, 5].map((n) => <button type="button" key={n} role="radio" aria-checked={csat === n} aria-label={t("fb_stars", { n })} className={csat >= n ? "on" : ""} onClick={() => setCsat(n)}>★</button>)}
        </div>
      </fieldset>
      <fieldset><legend>{t("fb_recommend")}</legend>
        <div className="nps" role="radiogroup" aria-label={t("fb_recommend")}>{Array.from({ length: 11 }, (_, n) => <button type="button" key={n} role="radio" aria-checked={nps === n} className={nps === n ? "on" : ""} onClick={() => setNps(n)}>{n}</button>)}</div>
        <div className="nps-ends meta"><span>{t("fb_notLikely")}</span><span>{t("fb_veryLikely")}</span></div>
      </fieldset>
      <label className="field">{t("fb_comment")}<textarea rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
      {state === "error" && <p className="error" role="alert">{t("fb_error")}</p>}
      <button className="btn primary" disabled={!csat && nps == null}>{t("fb_send")}</button>
    </form>
  );
}

/** The page a customer opens from a tracking link. No sign-in, no driver name, no plate. */
export default function TrackPage() {
  const { token } = useParams<{ token: string }>();
  const { t, locale } = useI18n();
  const [data, setData] = useState<Track | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "gone" | "busy">("loading");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/public/track/${encodeURIComponent(token)}`);
      if (res.status === 404) { setState("gone"); return; }
      if (res.status === 429) { setState("busy"); return; }
      if (!res.ok) throw new Error();
      setData(await res.json());
      setState("ok");
    } catch { setState((s) => (s === "ok" ? s : "busy")); }
  }, [token]);

  useEffect(() => {
    void load();
    const id = setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const brand = data?.org.color && /^#[0-9a-f]{3,8}$/i.test(data.org.color) ? data.org.color : "#0f5fa8";
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(iso));
  const next = data?.stops.find((s) => s.status !== "done" && s.status !== "skipped" && s.status !== "failed");

  return (
    <main className="track" style={{ ["--brand" as string]: brand }}>
      <header className="track-head">
        {data?.org.logo ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={data.org.logo} alt="" height={28} /> : null}
        <strong>{data?.org.name ?? "RouteNorth"}</strong>
        <span style={{ flex: 1 }} />
        <LanguageToggle />
      </header>
      {state === "loading" && <p className="track-note" role="status">{t("track_loading")}</p>}
      {state === "gone" && <div className="track-note" role="alert"><h1>{t("track_gone")}</h1><p>{t("track_goneHelp")}</p></div>}
      {state === "busy" && !data && <p className="track-note" role="alert">{t("track_busy")}</p>}
      {data && (
        <div className="track-body">
          <div className="track-map"><TrackMap data={data} brand={brand} /></div>
          <section className="track-card" aria-live="polite">
            <h1>{data.label ?? data.vehicle?.name ?? t("track_title")}</h1>
            {data.vehicle ? (
              <p>{t(`status_${data.vehicle.status}` as MessageKey)} · {data.vehicle.speed} km/h <span className="meta">· {t("lastUpdate")} {fmt(data.vehicle.time)}</span></p>
            ) : <p className="meta">{t("track_noPosition")}</p>}
            {next?.eta && <p className="track-eta">{t("track_next", { name: next.name, time: fmt(next.eta) })}</p>}
            {data.stops.length > 0 && (
              <ol className="stoplist" aria-label={t("f_stops")}>
                {data.stops.map((s) => (
                  <li key={s.sequence}><span>{s.sequence}. {s.name}</span> <span className="meta">{s.status === "done" ? t("v_done") : s.eta ? fmt(s.eta) : ""}</span></li>
                ))}
              </ol>
            )}
            {data.stops.length > 0 && !next && <Feedback token={token} />}
            <p className="meta">{t("track_expires", { time: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.expiresAt)) })}</p>
          </section>
        </div>
      )}
    </main>
  );
}
