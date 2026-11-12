import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pg } from "@routenorth/db";
import { Redis } from "ioredis";
import { normalizeTraccar, type TraccarForward } from "./traccar.js";
import { normalizeGeneric, type GenericBatch } from "./generic.js";
import { updateGeofences } from "./geofence.js";
import { updateRouteProgress } from "./progress.js";
import { authenticateFeedKey, keyFromRequest, withinRate } from "./feed.js";
import { countOutcome, flushCounters, ingestReading, outcomeKey, type Outcome } from "./store.js";
import { pullDueConnections } from "./connectors.js";


const pool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL, max: Number(process.env.DB_POOL ?? 10) });
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
const port = Number(process.env.PORT ?? 4100);
/** When set, every ingest request must carry it (header `Authorization: Bearer <token>` or query `?token=`). */
const token = process.env.INGEST_TOKEN ?? "";

const metrics = new Map<string, number>();
const bump = (name: string, n = 1) => metrics.set(name, (metrics.get(name) ?? 0) + n);

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!token) return true; // local development; production must set INGEST_TOKEN (see docs/DATA_PIPELINE.md)
  const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

/** Run one outcome through counters, live fan-out and route/geofence progress. */
async function afterIngest(source: string, o: Outcome) {
  countOutcome(source, o);
  bump(`routenorth_ingest_total{source="${source}",outcome="${outcomeKey(o)}"}`);
  if (o.kind !== "stored") return;
  // The API subscribes per organization and fans out over WebSockets.
  if (redis) await redis.publish(`positions:${o.position.orgId}`, JSON.stringify(o.position)).catch((err) => console.error("publish failed", err));
  // Route progress and geofences must never block or fail position storage.
  await updateRouteProgress(pool, o.position).catch((err) => console.error("route progress error", err));
  await updateGeofences(pool, o.position).catch((err) => console.error("geofence error", err));
}

const send = (res: ServerResponse, code: number, body = "", type = "text/plain") => res.writeHead(code, { "content-type": type }).end(body);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, "ok");
    if (req.method === "GET" && url.pathname === "/metrics") {
      if (!authorized(req, url)) return send(res, 401);
      return send(res, 200, [...metrics.entries()].map(([k, v]) => (k.includes("{") ? `${k} ${v}` : `${k} ${v}`)).join("\n") + "\n");
    }
    if (req.method !== "POST") return send(res, 404);

    // A company's own GPS feed: its provider, its own Traccar server or a gateway pushes with a per-company key.
    if (url.pathname === "/ingest/feed" || url.pathname === "/ingest/feed/traccar") {
      const feed = await authenticateFeedKey(pool, keyFromRequest(req.headers.authorization, url.searchParams.get("key")));
      if (!feed) { bump("routenorth_ingest_unauthorized_total"); return send(res, 401, "a valid GPS key is needed"); }
      if (!withinRate(feed.keyId)) { bump("routenorth_ingest_rate_limited_total"); return send(res, 429, "too many requests; send batches of up to 500 positions"); }
      if (url.pathname === "/ingest/feed/traccar") {
        // Traccar's "forward" feature, pointed at this address with ?key=... on the end.
        const raw = await readBody(req, 64_000);
        if (raw == null) return send(res, 413);
        const fix = normalizeTraccar(JSON.parse(raw) as TraccarForward);
        if (!fix) { bump("routenorth_ingest_unusable_total"); return send(res, 202, "ignored"); }
        const o = await ingestReading(pool, "feed", fix, new Date(), feed.orgId);
        await afterIngest("feed", o);
        return send(res, o.kind === "stored" ? 200 : 202, o.kind === "stored" ? "stored" : "ignored");
      }
      const raw = await readBody(req, 1_000_000);
      if (raw == null) return send(res, 413);
      const parsed = normalizeGeneric(JSON.parse(raw) as GenericBatch);
      if (parsed.error) return send(res, 400, JSON.stringify({ error: parsed.error }), "application/json");
      parsed.readings.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      const tally: Record<string, number> = { unusable: parsed.unusable };
      for (const r of parsed.readings) {
        const o = await ingestReading(pool, "feed", r, new Date(), feed.orgId);
        await afterIngest("feed", o);
        const k = o.kind === "unknown_device" ? "device_limit" : outcomeKey(o);
        tally[k] = (tally[k] ?? 0) + 1;
      }
      return send(res, 200, JSON.stringify({ received: parsed.readings.length + parsed.unusable, outcomes: tally }), "application/json");
    }

    if (!authorized(req, url)) { bump("routenorth_ingest_unauthorized_total"); return send(res, 401); }

    if (url.pathname === "/ingest/traccar") {
      const raw = await readBody(req, 64_000);
      if (raw == null) return send(res, 413);
      const fix = normalizeTraccar(JSON.parse(raw) as TraccarForward);
      if (!fix) { bump("routenorth_ingest_unusable_total"); return send(res, 202, "ignored"); }
      const o = await ingestReading(pool, "traccar", fix);
      await afterIngest("traccar", o);
      return send(res, o.kind === "stored" ? 200 : 202, o.kind === "stored" ? "stored" : "ignored");
    }

    if (url.pathname === "/ingest/positions") {
      // Batch endpoint for vendor APIs, phone apps and gateways. Devices are registered with source "api".
      if (!token) return send(res, 503, "set INGEST_TOKEN to enable the batch endpoint");
      const raw = await readBody(req, 1_000_000);
      if (raw == null) return send(res, 413);
      const parsed = normalizeGeneric(JSON.parse(raw) as GenericBatch);
      if (parsed.error) return send(res, 400, JSON.stringify({ error: parsed.error }), "application/json");
      // A batch is processed oldest first so "latest" ends on the newest fix and jump checks compare neighbours.
      parsed.readings.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      const tally: Record<string, number> = { unusable: parsed.unusable };
      for (const r of parsed.readings) {
        const o = await ingestReading(pool, "api", r);
        await afterIngest("api", o);
        tally[outcomeKey(o)] = (tally[outcomeKey(o)] ?? 0) + 1;
      }
      return send(res, 200, JSON.stringify({ received: parsed.readings.length + parsed.unusable, outcomes: tally }), "application/json");
    }
    return send(res, 404);
  } catch (err) {
    console.error("ingest error", err);
    bump("routenorth_ingest_errors_total");
    return send(res, err instanceof SyntaxError ? 400 : 500);
  }
});

const flusher = setInterval(() => void flushCounters(pool), 10_000);
flusher.unref();

// Pull connectors (Geotab, Samsara): sign in to a company's own provider account and pull new positions.
// Needs the same JWT_SECRET (or ENCRYPTION_KEY) as the API, which encrypted the saved logins.
const connectorKey = process.env.JWT_SECRET ?? "";
if ((connectorKey || process.env.ENCRYPTION_KEY) && process.env.CONNECTORS_DISABLED !== "1") {
  let running = false;
  const poller = setInterval(() => {
    if (running) return;
    running = true;
    pullDueConnections(pool, {
      fetchFn: (url, init) => fetch(url, init),
      secretKey: connectorKey,
      ingest: async (orgId, r) => { const o = await ingestReading(pool, "feed", r, new Date(), orgId); await afterIngest("feed", o); return o; },
    }).then((rs) => { for (const r of rs) bump(`routenorth_connector_pulls_total{outcome="${r.error ? "error" : "ok"}"}`); })
      .catch((err) => console.error("connector poll failed", err))
      .finally(() => { running = false; });
  }, Number(process.env.CONNECTOR_POLL_MS ?? 15_000));
  poller.unref();
} else {
  console.log("provider connectors off: set JWT_SECRET (same as the API) to pull from Geotab and Samsara accounts");
}

server.listen(port, () => console.log(`ingest listening on :${port}${token ? "" : " (INGEST_TOKEN not set: accepting unauthenticated requests)"}`));

const shutdown = () => {
  server.close();
  flushCounters(pool).finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
