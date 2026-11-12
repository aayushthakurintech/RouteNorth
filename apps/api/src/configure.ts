import type { INestApplication } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import express from "express";

/** Largest proof image accepted. Phones downscale photos before upload, so real files are far smaller. */
export const MAX_PROOF_BYTES = 6 * 1024 * 1024;
export const PROOF_TYPES = ["image/jpeg", "image/png", "image/webp"];
/** Files attached to jobs and incidents may also be PDFs. */
export const ATTACHMENT_TYPES = [...PROOF_TYPES, "application/pdf"];

/** Settings shared by the real server and the tests. */
export function configureApp(app: INestApplication): void {
  const http = app.getHttpAdapter().getInstance() as express.Express;
  http.disable("x-powered-by");
  // Behind a load balancer every request comes from the balancer, so rate limits, the IP allow list and the audit log
  // would see one address for everyone. TRUST_PROXY says which hops to believe: a count ("1") or addresses/ranges
  // ("10.0.0.0/8,loopback"). Never "true": then anyone could pick their own address with a header.
  const trust = trustProxySetting(process.env.TRUST_PROXY);
  if (trust !== undefined) http.set("trust proxy", trust);
  // The API answers with data, never pages, so browsers are told not to run, frame or sniff anything it sends.
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });
  // Proof uploads arrive as raw image bytes; everything else stays JSON.
  app.use(express.raw({ type: ATTACHMENT_TYPES, limit: MAX_PROOF_BYTES }));
  app.useWebSocketAdapter(new WsAdapter(app));
}

/** TRUST_PROXY as Express wants it: a hop count, a list of addresses or ranges, or undefined to trust nothing. */
export function trustProxySetting(raw: string | undefined): number | string[] | undefined {
  const v = raw?.trim();
  if (!v || v === "false" || v === "0") return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  if (v === "true") throw new Error("TRUST_PROXY=true would let anyone forge their address; give the number of proxies or their addresses");
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}
