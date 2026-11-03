export interface GeoHit { label: string; lat: number; lng: number; source: "saved" | "geocoder" }
export interface Geocoder { name: string; search(q: string, limit: number): Promise<GeoHit[]> }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Nominatim-compatible search (self-hosted Nominatim or Photon). Canada only. */
export class NominatimGeocoder implements Geocoder {
  readonly name = "nominatim";
  constructor(private readonly baseUrl: string, private readonly contact?: string, private readonly fetchImpl: Fetch = fetch) {}
  async search(q: string, limit: number): Promise<GeoHit[]> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/search?format=jsonv2&countrycodes=ca&limit=${limit}&q=${encodeURIComponent(q)}`;
    const res = await this.fetchImpl(url, { headers: { "User-Agent": `RouteNorth${this.contact ? ` (${this.contact})` : ""}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`geocoder ${res.status}`);
    const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
    return rows.map((r) => ({ label: r.display_name, lat: Number(r.lat), lng: Number(r.lon), source: "geocoder" as const })).filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng));
  }
}

export function geocoderFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: Fetch): Geocoder | null {
  return env.GEOCODER_URL ? new NominatimGeocoder(env.GEOCODER_URL, env.GEOCODER_CONTACT, fetchImpl) : null;
}
