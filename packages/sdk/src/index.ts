import { createHmac, timingSafeEqual } from "node:crypto";

export interface ClientOptions {
  /** Where RouteNorth runs, for example https://api.example.com */
  baseUrl: string;
  /** An API key from Integrations (starts with rn_api_). */
  apiKey: string;
  /** Use another fetch (for tests or proxies). */
  fetch?: typeof fetch;
}

export class RouteNorthError extends Error {
  constructor(public readonly status: number, message: string, public readonly body: unknown) { super(message); this.name = "RouteNorthError"; }
}

export type Json = Record<string, unknown>;
export interface Job { id: string; title: string; status: string; address?: string | null; scheduledDate?: string | null; [k: string]: unknown }
export interface Vehicle { id: string; name: string; [k: string]: unknown }
export interface LivePosition { deviceId: string; name: string; lat: number; lng: number; speed?: number; time?: string; [k: string]: unknown }

/** A thin, typed wrapper over the REST API. Throws RouteNorthError with the server's message when a call fails. */
export class RouteNorthClient {
  private readonly base: string;
  private readonly key: string;
  private readonly f: typeof fetch;

  constructor(o: ClientOptions) {
    if (!/^https?:\/\//.test(o.baseUrl)) throw new Error("baseUrl must start with http:// or https://");
    if (!/^rn_api_/.test(o.apiKey)) throw new Error("apiKey must be an API key (rn_api_…)");
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.key = o.apiKey;
    this.f = o.fetch ?? fetch;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const qs = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&") : "";
    const res = await this.f(`${this.base}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new RouteNorthError(res.status, (data as { message?: string } | null)?.message ?? `request failed with ${res.status}`, data);
    return data as T;
  }

  /** Records: vehicles, jobs, depots, drivers' documents and more. See the API description for the names. */
  records<T = Json>(resource: string) {
    const p = `/r/${encodeURIComponent(resource)}`;
    return {
      list: (query?: Record<string, string | number | undefined>) => this.request<T[]>("GET", p, undefined, query),
      get: (id: string) => this.request<T>("GET", `${p}/${encodeURIComponent(id)}`),
      create: (body: Json) => this.request<T>("POST", p, body),
      update: (id: string, body: Json) => this.request<T>("PATCH", `${p}/${encodeURIComponent(id)}`, body),
      remove: (id: string) => this.request<{ ok: boolean }>("DELETE", `${p}/${encodeURIComponent(id)}`),
    };
  }

  readonly jobs = {
    list: (query?: { q?: string; status?: string; scheduledDate?: string }) => this.records<Job>("jobs").list(query),
    get: (id: string) => this.records<Job>("jobs").get(id),
    create: (job: { title: string; address?: string; scheduledDate?: string; customerName?: string; customerPhone?: string; customerEmail?: string; notes?: string; [k: string]: unknown }) => this.records<Job>("jobs").create(job),
    update: (id: string, patch: Json) => this.records<Job>("jobs").update(id, patch),
    assign: (id: string, driverId: string | null) => this.request<Json>("POST", `/jobs/${encodeURIComponent(id)}/assign`, { driverId }),
    setStatus: (id: string, status: string, extra: Json = {}) => this.request<Json>("POST", `/jobs/${encodeURIComponent(id)}/status`, { status, ...extra }),
  };

  readonly vehicles = {
    list: () => this.records<Vehicle>("vehicles").list(),
    live: () => this.request<LivePosition[]>("GET", "/vehicles/live"),
  };

  routes(date?: string) { return this.request<Json[]>("GET", "/routes", undefined, { date }); }
  board(date?: string) { return this.request<Json>("GET", "/jobs/board", undefined, { date }); }
}

/** Check a webhook delivery. `header` is the routenorth-signature header (`t=<seconds>,v1=<hex>`), `body` the raw text. Rejects old timestamps to stop replays. */
export function verifyWebhook(secret: string, header: string, body: string, opts: { toleranceSeconds?: number; now?: number } = {}): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return false;
  const want = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(want), b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}
