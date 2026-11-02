import { createServer } from "node:http";
import { pg } from "@routenorth/db";
import { Redis } from "ioredis";
import { normalizeTraccar, type TraccarForward } from "./traccar.js";
import { storeFix } from "./store.js";

const pool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL });
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
const port = Number(process.env.PORT ?? 4100);

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method !== "POST" || req.url !== "/ingest/traccar") {
    res.writeHead(404).end();
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64_000) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const fix = normalizeTraccar(JSON.parse(Buffer.concat(chunks).toString()) as TraccarForward);
    if (!fix) { res.writeHead(202).end("ignored"); return; }
    const stored = await storeFix(pool, "traccar", fix);
    if (stored && redis) {
      // The API subscribes per organization and fans out over WebSockets (step 3).
      await redis.publish(`positions:${stored.orgId}`, JSON.stringify(stored));
    }
    res.writeHead(stored ? 200 : 202).end(stored ? "stored" : "ignored");
  } catch (err) {
    console.error("ingest error", err);
    res.writeHead(500).end();
  }
});

server.listen(port, () => console.log(`ingest listening on :${port}`));
