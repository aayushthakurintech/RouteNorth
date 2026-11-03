import { summarizeWeather, type WeatherSummary } from "@routenorth/shared";

export interface WeatherProvider {
  name: string;
  /** Forecast for a place at a time (nearest hour). */
  at(lat: number, lng: number, whenMs: number): Promise<WeatherSummary>;
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Open-Meteo: free, no key. Results are cached per ~10 km cell and hour so a busy map makes few requests. */
export class OpenMeteo implements WeatherProvider {
  readonly name = "open-meteo";
  private readonly cache = new Map<string, { at: number; hourly: Record<string, (number | null)[]> & { time: string[] } }>();
  constructor(private readonly baseUrl = "https://api.open-meteo.com", private readonly fetchImpl: Fetch = fetch) {}

  private async hourly(lat: number, lng: number) {
    const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.hourly;
    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lng.toFixed(2)}` +
      "&hourly=temperature_2m,precipitation,precipitation_probability,wind_speed_10m,weather_code&timezone=UTC&forecast_days=3&past_days=1";
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`weather ${res.status}`);
    const j = (await res.json()) as { hourly?: Record<string, (number | null)[]> & { time: string[] } };
    if (!j.hourly?.time) throw new Error("weather returned no data");
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(key, { at: Date.now(), hourly: j.hourly });
    return j.hourly;
  }

  async at(lat: number, lng: number, whenMs: number): Promise<WeatherSummary> {
    const h = await this.hourly(lat, lng);
    let best = 0, bestD = Infinity;
    h.time.forEach((t, i) => { const d = Math.abs(Date.parse(`${t}Z`) - whenMs); if (d < bestD) { bestD = d; best = i; } });
    const v = (k: string) => Number(h[k]?.[best] ?? 0);
    return summarizeWeather({ tempC: v("temperature_2m"), precipMm: v("precipitation"), precipProb: v("precipitation_probability"), windKmh: v("wind_speed_10m"), code: v("weather_code") });
  }
}

export function weatherFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: Fetch): WeatherProvider | null {
  if (env.WEATHER_URL === "off") return null;
  return new OpenMeteo(env.WEATHER_URL || undefined, fetchImpl);
}
