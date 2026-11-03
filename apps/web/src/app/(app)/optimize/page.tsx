"use client";
import type { MessageKey } from "@routenorth/shared";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, Kpi, PageHead, SkeletonList, TabDef, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

const today = () => new Date().toLocaleDateString("en-CA");
const n1 = (x: number | null | undefined) => (x == null ? "–" : (Math.round(x * 10) / 10).toLocaleString());
interface Driver { id: string; name: string }
const useDrivers = () => useApi<Driver[]>("/fleet/drivers");

function Areas() {
  const { t } = useI18n(); const { toast } = useToast(); const { can } = useMe();
  const saved = useApi<{ id: string; name: string; color: string; polygon: [number, number][]; driverId: string | null; driverName: string | null }[]>("/optimize/territories");
  const drivers = useDrivers();
  const [sugg, setSugg] = useState<{ points: number; areas: { name: string; stops: number; polygon: [number, number][]; driverId: string | null; driverName: string | null }[]; reason?: string } | null>(null);
  const [count, setCount] = useState("");
  const write = can("routes.dispatch");
  async function suggest() { try { setSugg(await apiSend("POST", "/optimize/territories/suggest", { count: count ? Number(count) : undefined })); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function save(a: NonNullable<typeof sugg>["areas"][number]) { try { await apiSend("POST", "/optimize/territories", { name: a.name, polygon: a.polygon, driverId: a.driverId }); toast(t("op_saved")); saved.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function assign(id: string, driverId: string) { try { await apiSend("PATCH", `/optimize/territories/${id}`, { driverId: driverId || null }); saved.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function remove(id: string) { try { await apiSend("DELETE", `/optimize/territories/${id}`); saved.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  const all = [...(saved.data ?? []).map((a) => a.polygon), ...(sugg?.areas ?? []).map((a) => a.polygon)];
  return (
    <div className="stack">
      <p className="meta small">{t("op_areasNote")}</p>
      <div className="row">
        <label>{t("op_areaCount")} <input type="number" min={1} max={12} value={count} onChange={(e) => setCount(e.target.value)} style={{ width: 80 }} /></label>
        <button className="btn primary" onClick={() => void suggest()}>{t("op_suggestAreas")}</button>
      </div>
      {all.length > 0 && <AreaMap polys={[...(saved.data ?? []).map((a) => ({ p: a.polygon, c: a.color })), ...(sugg?.areas ?? []).map((a, i) => ({ p: a.polygon, c: PALETTE[i % PALETTE.length]! }))]} label={t("op_areaMap")} />}
      {sugg && (sugg.areas.length === 0 ? <EmptyState title={t("op_notEnoughStops")} body={t("op_notEnoughStopsBody")} /> : (
        <table className="ptable">
          <thead><tr><th>{t("op_suggested")}</th><th className="tnum">{t("op_stops")}</th><th>{t("f_driver")}</th><th /></tr></thead>
          <tbody>{sugg.areas.map((a) => <tr key={a.name}><td>{a.name}</td><td className="tnum">{a.stops}</td><td>{a.driverName ?? "–"}</td><td>{write && <button className="btn" onClick={() => void save(a)}>{t("op_keepArea")}</button>}</td></tr>)}</tbody>
        </table>
      ))}
      <h2>{t("op_savedAreas")}</h2>
      {saved.error ? <ErrorState error={saved.error} onRetry={saved.reload} /> : !saved.loaded ? <SkeletonList rows={2} /> : saved.data!.length === 0 ? <EmptyState title={t("op_noAreas")} body={t("op_noAreasBody")} /> : (
        <table className="ptable">
          <thead><tr><th>{t("op_area")}</th><th>{t("f_driver")}</th><th /></tr></thead>
          <tbody>{saved.data!.map((a) => (
            <tr key={a.id}><td><span className="swatch" style={{ background: a.color, display: "inline-block", width: 10, height: 10, borderRadius: 3, marginInlineEnd: 6 }} />{a.name}</td>
              <td>{write ? <select aria-label={t("f_driver")} value={a.driverId ?? ""} onChange={(e) => void assign(a.id, e.target.value)}><option value="">{t("op_shared")}</option>{(drivers.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select> : (a.driverName ?? t("op_shared"))}</td>
              <td>{write && <button className="btn" onClick={() => void remove(a.id)}>{t("delete")}</button>}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

const PALETTE = ["#2563eb", "#d97706", "#059669", "#9333ea", "#dc2626", "#0891b2", "#be185d", "#4d7c0f"];
function AreaMap({ polys, label }: { polys: { p: [number, number][]; c: string }[]; label: string }) {
  const pts = polys.flatMap((x) => x.p);
  if (pts.length === 0) return null;
  const lat = pts.map((p) => p[0]), lng = pts.map((p) => p[1]);
  const [a, b, c, d] = [Math.min(...lat), Math.max(...lat), Math.min(...lng), Math.max(...lng)];
  const W = 520, H = 220, pad = 12, sx = (W - pad * 2) / Math.max(1e-6, d - c), sy = (H - pad * 2) / Math.max(1e-6, b - a), s = Math.min(sx, sy);
  const xy = (p: [number, number]) => `${(pad + (p[1] - c) * s).toFixed(1)},${(H - pad - (p[0] - a) * s).toFixed(1)}`;
  return <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 560, background: "var(--bg-elev, transparent)", border: "1px solid var(--line)", borderRadius: 8 }}>{polys.map((x, i) => <polygon key={i} points={x.p.map(xy).join(" ")} fill={x.c} fillOpacity={0.25} stroke={x.c} strokeWidth={2} />)}</svg>;
}

function Balance() {
  const { t } = useI18n(); const { toast } = useToast(); const { can } = useMe();
  const [date, setDate] = useState(today());
  const b = useApi<{ loads: { id: string; name: string; stops: number; minutes: number; km: number }[]; spreadPct: number; fair: boolean; meanMinutes: number; moves: { stopId: string; fromId: string; toId: string; minutes: number }[] }>(`/optimize/balance?date=${date}`);
  async function apply() { try { await apiSend("POST", "/optimize/balance/apply", { date, moves: b.data!.moves.map((m) => ({ stopId: m.stopId, toId: m.toId })) }); toast(t("op_balanced")); b.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  const name = (id: string) => b.data?.loads.find((l) => l.id === id)?.name ?? id;
  const max = Math.max(1, ...(b.data?.loads ?? []).map((l) => l.minutes));
  return (
    <div className="stack">
      <label>{t("f_date")} <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      {b.error ? <ErrorState error={b.error} onRetry={b.reload} /> : !b.loaded ? <SkeletonList rows={3} /> : b.data!.loads.length === 0 ? <EmptyState title={t("op_noDrivers")} /> : (
        <>
          <div className="kpi-row"><Kpi label={t("op_avgLoad")} value={Math.round(b.data!.meanMinutes / 6) / 10} format={(x) => `${x.toFixed(1)} h`} /><Kpi label={t("op_spread")} value={b.data!.spreadPct} format={(x) => `${Math.round(x)}%`} /></div>
          <p>{b.data!.fair ? <Chip tone="ok">{t("op_fair")}</Chip> : <Chip tone="warn">{t("op_uneven")}</Chip>}</p>
          <table className="ptable">
            <thead><tr><th>{t("f_driver")}</th><th className="tnum">{t("op_stops")}</th><th className="tnum">km</th><th>{t("op_load")}</th></tr></thead>
            <tbody>{b.data!.loads.map((l) => <tr key={l.id}><td>{l.name}</td><td className="tnum">{l.stops}</td><td className="tnum">{n1(l.km)}</td><td style={{ minWidth: 200 }}><div role="img" aria-label={`${Math.round(l.minutes / 6) / 10} h`} style={{ background: "var(--brand)", height: 10, borderRadius: 4, width: `${(l.minutes / max) * 100}%`, minWidth: l.minutes ? 4 : 0 }} /><span className="meta small">{Math.round(l.minutes / 6) / 10} h</span></td></tr>)}</tbody>
          </table>
          {b.data!.moves.length > 0 && (
            <div className="card" style={{ padding: "var(--s3) var(--s4)" }}>
              <strong>{t("op_suggestedMoves", { n: b.data!.moves.length })}</strong>
              <ul className="small">{Object.entries(b.data!.moves.reduce<Record<string, number>>((m, x) => { const k = `${x.fromId}>${x.toId}`; m[k] = (m[k] ?? 0) + 1; return m; }, {})).map(([k, n]) => { const [f, to] = k.split(">"); return <li key={k}>{t("op_moveLine", { n, from: name(f!), to: name(to!) })}</li>; })}</ul>
              {can("routes.dispatch") && <button className="btn primary" onClick={() => void apply()}>{t("op_applyMoves")}</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Depots() {
  const { t } = useI18n(); const { toast } = useToast(); const { can } = useMe();
  const [date, setDate] = useState(today());
  const [r, setR] = useState<{ depots: { depotId: string; name: string; jobs: number; drivers: number; km: number; unassigned: number }[]; applied: boolean; reason?: string } | null>(null);
  async function go(apply: boolean) { try { setR(await apiSend("POST", "/optimize/multi-depot", { date, apply })); if (apply) toast(t("op_planned")); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <div className="stack">
      <p className="meta small">{t("op_depotsNote")}</p>
      <div className="row"><label>{t("f_date")} <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label><button className="btn primary" onClick={() => void go(false)}>{t("op_preview")}</button></div>
      {r?.reason === "one_depot" && <EmptyState title={t("op_oneDepot")} body={t("op_oneDepotBody")} />}
      {r && r.depots.length > 0 && (
        <>
          <table className="ptable"><thead><tr><th>{t("op_depot")}</th><th className="tnum">{t("op_jobs")}</th><th className="tnum">{t("op_driversHere")}</th><th className="tnum">km</th><th className="tnum">{t("op_unplaced")}</th></tr></thead>
            <tbody>{r.depots.map((d) => <tr key={d.depotId}><td>{d.name}</td><td className="tnum">{d.jobs}</td><td className="tnum">{d.drivers}</td><td className="tnum">{n1(d.km)}</td><td className="tnum">{d.unassigned > 0 ? <Chip tone="warn">{d.unassigned}</Chip> : 0}</td></tr>)}</tbody></table>
          {!r.applied && can("routes.dispatch") && <button className="btn primary" onClick={() => void go(true)}>{t("op_applyPlan")}</button>}
        </>
      )}
    </div>
  );
}

function Cost() {
  const { t } = useI18n(); const { toast } = useToast(); const { can } = useMe();
  const [date, setDate] = useState(today());
  const [routeId, setRouteId] = useState("");
  const routes = useApi<{ id: string; name: string }[]>(`/routes?date=${date}`);
  const c = useApi<{ options: { id: string; km: number; minutes: number; late: number; valid: boolean; cost: { fuel: number; wages: number; wear: number; tolls: number; total: number; co2Kg: number } }[]; cheapest: string; greenest: string; vehicles: { vehicleId: string; name: string; fuelType: string; co2Kg: number; current: boolean }[]; reason?: string }>(routeId ? `/optimize/compare?routeId=${routeId}` : null);
  async function apply(option: string) { try { await apiSend("POST", "/optimize/compare/apply", { routeId, option }); toast(t("op_orderApplied")); c.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  const money = (x: number) => x.toLocaleString(undefined, { style: "currency", currency: "CAD" });
  return (
    <div className="stack">
      <p className="meta small">{t("op_costNote")}</p>
      <div className="row">
        <label>{t("f_date")} <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setRouteId(""); }} /></label>
        <label>{t("ai_route")} <select value={routeId} onChange={(e) => setRouteId(e.target.value)}><option value="">{t("ai_pickRoute")}</option>{(routes.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      </div>
      {c.error && <ErrorState error={c.error} onRetry={c.reload} />}
      {c.data?.reason === "too_few_stops" && <EmptyState title={t("op_tooFew")} />}
      {c.data && c.data.options.length > 0 && (
        <>
          <table className="ptable">
            <thead><tr><th>{t("op_option")}</th><th className="tnum">km</th><th className="tnum">{t("ai_min")}</th><th className="tnum">{t("op_fuel")}</th><th className="tnum">{t("op_wages")}</th><th className="tnum">{t("op_wear")}</th><th className="tnum">{t("op_tolls")}</th><th className="tnum">{t("op_total")}</th><th className="tnum">CO₂ kg</th><th /></tr></thead>
            <tbody>{c.data.options.map((o) => (
              <tr key={o.id}><td>{t(`op_opt_${o.id}` as MessageKey)}{o.id === c.data!.cheapest && <> <Chip tone="ok">{t("op_cheapest")}</Chip></>}{o.id === c.data!.greenest && <> <Chip tone="info">{t("op_greenest")}</Chip></>}{o.late > 0 && <> <Chip tone="warn">{t("op_late", { n: o.late })}</Chip></>}</td>
                <td className="tnum">{n1(o.km)}</td><td className="tnum">{o.minutes}</td><td className="tnum">{money(o.cost.fuel)}</td><td className="tnum">{money(o.cost.wages)}</td><td className="tnum">{money(o.cost.wear)}</td><td className="tnum">{money(o.cost.tolls)}</td><td className="tnum"><strong>{money(o.cost.total)}</strong></td><td className="tnum">{n1(o.cost.co2Kg)}</td>
                <td>{can("routes.dispatch") && o.id !== "current" && <button className="btn" onClick={() => void apply(o.id)}>{t("op_useOrder")}</button>}</td></tr>
            ))}</tbody>
          </table>
          <h2>{t("op_greenVehicle")}</h2>
          <table className="ptable"><thead><tr><th>{t("f_vehicle")}</th><th>{t("op_fuelType")}</th><th className="tnum">CO₂ kg</th></tr></thead>
            <tbody>{c.data.vehicles.map((v) => <tr key={v.vehicleId}><td>{v.name}{v.current && <> <Chip>{t("op_current")}</Chip></>}</td><td>{v.fuelType}</td><td className="tnum">{n1(v.co2Kg)}</td></tr>)}</tbody></table>
        </>
      )}
    </div>
  );
}

function Returns() {
  const { t } = useI18n();
  const [date, setDate] = useState(today());
  const [routeId, setRouteId] = useState("");
  const routes = useApi<{ id: string; name: string }[]>(`/routes?date=${date}`);
  const b = useApi<{ spareKg: number | null; candidates: { id: string; title: string; address: string | null; detourKm: number }[]; reason?: string }>(routeId ? `/optimize/backhaul?routeId=${routeId}` : null);
  const [rides, setRides] = useState<{ requests: number; vehiclesSaved: number; groups: { ids: string[]; seats: number; titles: string[] }[] } | null>(null);
  const pairs = useApi<{ pairs: { pickupId: string; pickup: string; delivery: string; state: string }[] }>(`/optimize/pairs?date=${date}`);
  const { toast } = useToast(); const { can } = useMe();
  async function fix() { try { const r = await apiSend<{ fixed: number }>("POST", "/optimize/pairs/fix", { date }); toast(t("op_fixed", { n: r.fixed })); pairs.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function groupRides() { try { setRides(await apiSend("POST", "/optimize/rides", { date, seats: 4 })); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <div className="stack">
      <label>{t("f_date")} <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setRouteId(""); }} /></label>
      <h2>{t("op_backhaul")}</h2>
      <p className="meta small">{t("op_backhaulNote")}</p>
      <label>{t("ai_route")} <select value={routeId} onChange={(e) => setRouteId(e.target.value)}><option value="">{t("ai_pickRoute")}</option>{(routes.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      {b.data && (b.data.candidates.length === 0 ? <EmptyState title={t("op_noReturn")} body={b.data.reason === "no_depot" ? t("op_noDepotBody") : undefined} /> : (
        <table className="ptable"><thead><tr><th>{t("op_pickup")}</th><th className="tnum">{t("op_detour")}</th></tr></thead><tbody>{b.data.candidates.map((c) => <tr key={c.id}><td>{c.title}<div className="meta small">{c.address}</div></td><td className="tnum">+{n1(c.detourKm)} km</td></tr>)}</tbody></table>
      ))}
      <h2>{t("op_pairs")}</h2>
      <p className="meta small">{t("op_pairsNote")}</p>
      {pairs.loaded && (pairs.data!.pairs.length === 0 ? <EmptyState title={t("op_noPairs")} /> : (
        <>
          <table className="ptable"><thead><tr><th>{t("op_pickup")}</th><th>{t("op_delivery")}</th><th>{t("op_state")}</th></tr></thead>
            <tbody>{pairs.data!.pairs.map((p) => <tr key={p.pickupId}><td>{p.pickup}</td><td>{p.delivery}</td><td><Chip tone={p.state === "ok" ? "ok" : p.state === "waiting" ? "info" : "warn"}>{t(`op_pair_${p.state}` as MessageKey)}</Chip></td></tr>)}</tbody></table>
          {can("routes.dispatch") && pairs.data!.pairs.some((p) => !["ok", "waiting"].includes(p.state)) && <button className="btn primary" onClick={() => void fix()}>{t("op_fixPairs")}</button>}
        </>
      ))}
      <h2>{t("op_rides")}</h2>
      <p className="meta small">{t("op_ridesNote")}</p>
      <button className="btn" onClick={() => void groupRides()}>{t("op_groupRides")}</button>
      {rides && (rides.requests === 0 ? <EmptyState title={t("op_noRides")} body={t("op_noRidesBody")} /> : (
        <><p>{t("op_ridesResult", { n: rides.requests, m: rides.groups.length })}</p>
          <ul>{rides.groups.map((g, i) => <li key={i}>{g.titles.join(" + ")} <span className="meta small">({g.seats} {t("op_seats")})</span></li>)}</ul></>
      ))}
    </div>
  );
}

function WhatIf() {
  const { t } = useI18n(); const { toast } = useToast();
  const [f, setF] = useState({ date: today(), addVehicles: "0", removeVehicles: "0", maxShiftMin: "", capacityKg: "", lat: "", lng: "" });
  const [r, setR] = useState<{ jobs: number; baseline: Sum | null; scenario: Sum | null; delta: { km: number; cost: number; unserved: number; late: number } | null } | null>(null);
  interface Sum { vehicles: number; used: number; served: number; unserved: number; late: number; km: number; hours: number; cost: number }
  async function run() {
    try {
      setR(await apiSend("POST", "/optimize/simulate", {
        date: f.date, addVehicles: Number(f.addVehicles), removeVehicles: Number(f.removeVehicles), maxShiftMin: f.maxShiftMin ? Number(f.maxShiftMin) : undefined, capacityKg: f.capacityKg ? Number(f.capacityKg) : undefined,
        depot: f.lat && f.lng ? { lat: Number(f.lat), lng: Number(f.lng) } : undefined,
      }));
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const money = (x: number) => x.toLocaleString(undefined, { style: "currency", currency: "CAD" });
  const row = (label: string, a: number | undefined, b: number | undefined, fmt: (x: number) => string = n1, lowerBetter = true) => (
    <tr><td>{label}</td><td className="tnum">{a == null ? "–" : fmt(a)}</td><td className="tnum">{b == null ? "–" : fmt(b)}</td><td className="tnum">{a != null && b != null && a !== b ? <Chip tone={(b < a) === lowerBetter ? "ok" : "warn"}>{b > a ? "+" : ""}{fmt(b - a)}</Chip> : "–"}</td></tr>
  );
  return (
    <div className="stack">
      <p className="meta small">{t("op_simNote")}</p>
      <div className="grid2">
        <label>{t("f_date")}<input type="date" value={f.date} onChange={set("date")} /></label>
        <label>{t("op_addVehicles")}<input type="number" min={0} max={20} value={f.addVehicles} onChange={set("addVehicles")} /></label>
        <label>{t("op_removeVehicles")}<input type="number" min={0} max={50} value={f.removeVehicles} onChange={set("removeVehicles")} /></label>
        <label>{t("op_shiftMin")}<input type="number" min={60} max={1000} value={f.maxShiftMin} onChange={set("maxShiftMin")} placeholder="600" /></label>
        <label>{t("op_capacity")}<input type="number" min={0} value={f.capacityKg} onChange={set("capacityKg")} /></label>
        <label>{t("op_newDepotLat")}<input type="number" step="any" value={f.lat} onChange={set("lat")} /></label>
        <label>{t("op_newDepotLng")}<input type="number" step="any" value={f.lng} onChange={set("lng")} /></label>
      </div>
      <button className="btn primary" onClick={() => void run()}>{t("op_runSim")}</button>
      {r && (r.jobs === 0 || !r.baseline || !r.scenario ? <EmptyState title={t("op_simNoJobs")} body={t("op_simNoJobsBody")} /> : (
        <table className="ptable">
          <thead><tr><th>{t("op_measure")}</th><th className="tnum">{t("op_today")}</th><th className="tnum">{t("op_withChange")}</th><th className="tnum">{t("op_difference")}</th></tr></thead>
          <tbody>
            {row(t("op_vehicles"), r.baseline.vehicles, r.scenario.vehicles, (x) => String(x), false)}
            {row(t("op_unserved"), r.baseline.unserved, r.scenario.unserved, (x) => String(x))}
            {row(t("op_lateStops"), r.baseline.late, r.scenario.late, (x) => String(x))}
            {row("km", r.baseline.km, r.scenario.km)}
            {row(t("op_hours"), r.baseline.hours, r.scenario.hours)}
            {row(t("op_total"), r.baseline.cost, r.scenario.cost, money)}
          </tbody>
        </table>
      ))}
    </div>
  );
}

function Prefs() {
  const { t } = useI18n(); const { toast } = useToast(); const { can } = useMe();
  const drivers = useDrivers();
  const [id, setId] = useState("");
  const p = useApi<{ maxStops?: number; avoidCustomers?: string[]; daysOff?: string[]; note?: string; skills: string[] }>(id ? `/optimize/preferences/${id}` : null);
  const [f, setF] = useState<{ maxStops: string; avoid: string; off: string } | null>(null);
  const cur = f ?? (p.data ? { maxStops: String(p.data.maxStops ?? ""), avoid: (p.data.avoidCustomers ?? []).join(", "), off: (p.data.daysOff ?? []).join(", ") } : null);
  async function save() {
    if (!cur) return;
    try { await apiSend("PUT", `/optimize/preferences/${id}`, { maxStops: cur.maxStops || undefined, avoidCustomers: cur.avoid.split(",").map((x) => x.trim()).filter(Boolean), daysOff: cur.off.split(",").map((x) => x.trim()).filter(Boolean) }); toast(t("op_saved")); setF(null); p.reload(); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  return (
    <div className="stack">
      <p className="meta small">{t("op_prefsNote")}</p>
      <label>{t("f_driver")} <select value={id} onChange={(e) => { setId(e.target.value); setF(null); }}><option value="">{t("op_pickDriver")}</option>{(drivers.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      {id && cur && (
        <div className="stack">
          <p className="small">{t("op_skills")}: {p.data?.skills.length ? p.data.skills.join(", ") : "–"}</p>
          <label>{t("op_maxStops")}<input type="number" min={1} max={200} value={cur.maxStops} onChange={(e) => setF({ ...cur, maxStops: e.target.value })} /></label>
          <label>{t("op_avoid")}<input value={cur.avoid} onChange={(e) => setF({ ...cur, avoid: e.target.value })} placeholder="Acme, Beta Ltd" /></label>
          <label>{t("op_daysOff")}<input value={cur.off} onChange={(e) => setF({ ...cur, off: e.target.value })} placeholder="2026-12-24, 2026-12-25" /></label>
          {can("fleet.manage") && <button className="btn primary" onClick={() => void save()}>{t("save")}</button>}
        </div>
      )}
    </div>
  );
}

export default function OptimizePage() {
  const { t } = useI18n();
  const [tab, setTab] = useState("areas");
  const tabs: TabDef[] = ["areas", "balance", "depots", "cost", "returns", "whatif", "prefs"].map((id) => ({ id, label: t(`op_tab_${id}` as MessageKey) }));
  return (
    <div className="content">
      <PageHead title={t("navOptimize")} subtitle={t("op_subtitle")} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label={t("navOptimize")} />
      <div role="tabpanel" style={{ marginTop: "var(--s4)" }}>
        {tab === "areas" && <Areas />}{tab === "balance" && <Balance />}{tab === "depots" && <Depots />}{tab === "cost" && <Cost />}
        {tab === "returns" && <Returns />}{tab === "whatif" && <WhatIf />}{tab === "prefs" && <Prefs />}
      </div>
    </div>
  );
}
