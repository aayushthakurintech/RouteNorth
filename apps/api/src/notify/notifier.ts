import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Sending messages out: email, SMS, Slack, Teams and generic webhooks.
 * Each channel is a small adapter over `fetch`, so tests can stand in for the network. Email and SMS need an outside account
 * (an email API key, a Twilio account), so they stay switched off until the environment variables are set.
 */
export type EndpointKind = "email" | "slack" | "teams" | "sms" | "webhook";
export interface Endpoint { id: string; kind: EndpointKind; target: string; label: string }
export interface Attachment { name: string; contentType: string; data: Uint8Array }
export interface Message {
  subject: string; text: string; link?: string; severity?: "info" | "warn" | "critical"; attachments?: Attachment[];
  /** Email only: a styled version of the message. */
  html?: string;
  /** SMS only: send the text as it is, without the subject in front. */
  plain?: boolean;
}

export type Fetch = typeof fetch;

export interface Providers {
  fetch: Fetch;
  /** Resend-compatible email API. */
  email?: { apiKey: string; from: string; url?: string } | null;
  /** Twilio SMS. */
  sms?: { accountSid: string; authToken: string; from: string; url?: string } | null;
  /**
   * Checks a customer-set address just before it is called (the real server resolves its name and refuses private
   * addresses). Left out in tests, which stand in for the network.
   */
  guard?: (url: string) => Promise<string | null>;
}
/** `unconfigured` means the server has no account for this channel (not that the send was tried and failed). */
export type Result = { ok: true } | { ok: false; error: string; unconfigured?: boolean };

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Providers {
  return {
    // A slow server must not hold up the rest of the pass. Redirects are not followed, so a public address cannot
    // bounce the call to an internal one.
    fetch: ((url, init) => fetch(url, { ...init, redirect: "manual", signal: init?.signal ?? AbortSignal.timeout(10_000) })) as Fetch,
    guard: (url) => publicAddressProblem(url),
    email: env.RESEND_API_KEY && env.EMAIL_FROM ? { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, url: env.EMAIL_API_URL } : null,
    sms: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM, url: env.TWILIO_API_URL } : null,
  };
}

const PRIVATE = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;
/** Webhook addresses are set by customers and called by our server, so only public https addresses are allowed. */
export function isSafeWebhookUrl(raw: string): boolean {
  try { const u = new URL(raw); return u.protocol === "https:" && !u.username && !u.password && !PRIVATE.test(u.hostname); } catch { return false; }
}
/** True for loopback, private, link-local, carrier-grade NAT, multicast and other addresses that are not on the public internet. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]!);
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith("64:ff9b:");
  }
  return true;
}

/**
 * Resolves the address's host name and says why it must not be called, or null. The name check in isSafeWebhookUrl
 * alone can be beaten by a public name that points at a private address.
 */
export async function publicAddressProblem(raw: string, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address)): Promise<string | null> {
  if (!isSafeWebhookUrl(raw)) return "the address is not a public https address";
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  let ips: string[];
  try { ips = isIP(host) ? [host] : await resolve(host); } catch { return "the address could not be found"; }
  if (!ips.length || ips.some(isPrivateIp)) return "the address points to a private network";
  return null;
}

export function checkTarget(kind: EndpointKind, target: string): string | null {
  switch (kind) {
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(target) && target.length <= 254 ? null : "enter a valid email address";
    case "sms": return /^\+[1-9]\d{7,14}$/.test(target) ? null : "enter a phone number like +14165550123";
    case "slack": return /^https:\/\/hooks\.slack\.com\/services\/[\w/-]+$/.test(target) ? null : "enter a Slack incoming-webhook address";
    case "teams": return isSafeWebhookUrl(target) && /(webhook\.office\.com|outlook\.office\.com|logic\.azure\.com|powerplatform\.com)/.test(target) ? null : "enter a Teams webhook address";
    default: return isSafeWebhookUrl(target) ? null : "enter a public https address";
  }
}

const ICON = { info: "ℹ️", warn: "⚠️", critical: "🚨" } as const;

export async function deliver(ep: Endpoint, m: Message, p: Providers): Promise<Result> {
  const bad = checkTarget(ep.kind, ep.target);
  if (bad) return { ok: false, error: bad };
  if (p.guard && (ep.kind === "slack" || ep.kind === "teams" || ep.kind === "webhook")) {
    const blocked = await p.guard(ep.target);
    if (blocked) return { ok: false, error: blocked };
  }
  try {
    let res: Response;
    switch (ep.kind) {
      case "slack":
        res = await p.fetch(ep.target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `${ICON[m.severity ?? "info"]} *${m.subject}*\n${m.text}${m.link ? `\n<${m.link}|Open>` : ""}` }) });
        break;
      case "teams":
        res = await p.fetch(ep.target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ "@type": "MessageCard", "@context": "https://schema.org/extensions", summary: m.subject, title: m.subject, text: m.text.replace(/\n/g, "<br>"), potentialAction: m.link ? [{ "@type": "OpenUri", name: "Open", targets: [{ os: "default", uri: m.link }] }] : [] }) });
        break;
      case "webhook":
        res = await p.fetch(ep.target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject: m.subject, text: m.text, link: m.link ?? null, severity: m.severity ?? "info" }) });
        break;
      case "email": {
        if (!p.email) return { ok: false, error: "email is not set up on this server (RESEND_API_KEY and EMAIL_FROM)", unconfigured: true };
        res = await p.fetch(p.email.url ?? "https://api.resend.com/emails", {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.email.apiKey}` },
          body: JSON.stringify({ from: p.email.from, to: [ep.target], subject: m.subject, text: `${m.text}${m.link ? `\n\n${m.link}` : ""}`, ...(m.html ? { html: m.html } : {}), attachments: (m.attachments ?? []).map((a) => ({ filename: a.name, content: Buffer.from(a.data).toString("base64") })) }),
        });
        break;
      }
      case "sms": {
        if (!p.sms) return { ok: false, error: "SMS is not set up on this server (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM)", unconfigured: true };
        const body = new URLSearchParams({ From: p.sms.from, To: ep.target, Body: (m.plain ? m.text : `${m.subject}: ${m.text}`).slice(0, 600) });
        res = await p.fetch(p.sms.url ?? `https://api.twilio.com/2010-04-01/Accounts/${p.sms.accountSid}/Messages.json`, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${p.sms.accountSid}:${p.sms.authToken}`).toString("base64")}` }, body,
        });
        break;
      }
    }
    return res.ok ? { ok: true } : { ok: false, error: `the service answered ${res.status}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
