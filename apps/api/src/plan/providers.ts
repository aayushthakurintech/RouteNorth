import type { LatLng } from "@routenorth/shared";

/** Real road travel times for a set of points. The planner falls back to estimates when none is configured or it fails. */
export interface Matrix { seconds: number[][]; metres: number[][] }
export interface MatrixOptions { avoid: readonly string[]; truck?: { heightM?: number | null; weightKg?: number | null; hazmat?: boolean } }
export interface RoutingProvider {
  name: string;
  matrix(points: readonly LatLng[], o: MatrixOptions): Promise<Matrix>;
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** OSRM `table` service: https://project-osrm.org/docs/v5.24.0/api/#table-service */
export class OsrmProvider implements RoutingProvider {
  readonly name = "osrm";
  constructor(private readonly baseUrl: string, private readonly fetchImpl: Fetch = fetch) {}
  async matrix(points: readonly LatLng[], o: MatrixOptions): Promise<Matrix> {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const exclude = [o.avoid.includes("tolls") && "toll", o.avoid.includes("highways") && "motorway", o.avoid.includes("ferries") && "ferry"].filter(Boolean).join(",");
    const url = `${this.baseUrl.replace(/\/$/, "")}/table/v1/driving/${coords}?annotations=duration,distance${exclude ? `&exclude=${exclude}` : ""}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const j = (await res.json()) as { code?: string; durations?: (number | null)[][]; distances?: (number | null)[][] };
    if (j.code !== "Ok" || !j.durations || !j.distances) throw new Error(`OSRM ${j.code ?? "error"}`);
    return { seconds: clean(j.durations), metres: clean(j.distances) };
  }
}

/** Valhalla `sources_to_targets`; its "truck" costing honours height, weight and hazmat limits. */
export class ValhallaProvider implements RoutingProvider {
  readonly name = "valhalla";
  constructor(private readonly baseUrl: string, private readonly fetchImpl: Fetch = fetch) {}
  async matrix(points: readonly LatLng[], o: MatrixOptions): Promise<Matrix> {
    const loc = points.map((p) => ({ lat: p.lat, lon: p.lng }));
    const use = { use_tolls: o.avoid.includes("tolls") ? 0 : 0.5, use_highways: o.avoid.includes("highways") ? 0 : 0.5, use_ferry: o.avoid.includes("ferries") ? 0 : 0.5 };
    const truck = o.truck && (o.truck.heightM || o.truck.weightKg || o.truck.hazmat);
    const body = {
      sources: loc, targets: loc, costing: truck ? "truck" : "auto",
      costing_options: truck
        ? { truck: { ...use, height: o.truck?.heightM ?? undefined, weight: o.truck?.weightKg ? o.truck.weightKg / 1000 : undefined, hazmat: !!o.truck?.hazmat } }
        : { auto: use },
    };
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/sources_to_targets`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Valhalla ${res.status}`);
    const j = (await res.json()) as { sources_to_targets?: { distance: number | null; time: number | null }[][] };
    if (!j.sources_to_targets) throw new Error("Valhalla returned no matrix");
    return {
      seconds: clean(j.sources_to_targets.map((row) => row.map((c) => c.time))),
      metres: clean(j.sources_to_targets.map((row) => row.map((c) => (c.distance == null ? null : c.distance * 1000)))),
    };
  }
}

/** A missing route (null) becomes a very long trip rather than a free one. */
function clean(m: (number | null)[][]): number[][] {
  return m.map((row) => row.map((v) => (v == null ? 1e7 : v)));
}

export function providerFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: Fetch): RoutingProvider | null {
  const url = env.ROUTING_URL;
  if (!url) return null;
  if (env.ROUTING_PROVIDER === "valhalla") return new ValhallaProvider(url, fetchImpl);
  if (env.ROUTING_PROVIDER === "osrm") return new OsrmProvider(url, fetchImpl);
  return null;
}
