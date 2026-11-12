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
  // Proof uploads arrive as raw image bytes; everything else stays JSON.
  app.use(express.raw({ type: ATTACHMENT_TYPES, limit: MAX_PROOF_BYTES }));
  app.useWebSocketAdapter(new WsAdapter(app));
}
