/**
 * Sending messages out: email, SMS, Slack, Teams and generic webhooks.
 * Each channel is a small adapter over `fetch`, so tests can stand in for the network. Email and SMS need an outside account
 * (an email API key, a Twilio account), so they stay switched off until the environment variables are set.
 */
export type EndpointKind = "email" | "slack" | "teams" | "sms" | "webhook";
export interface Endpoint { id: string; kind: EndpointKind; target: string; label: string }
export interface Attachment { name: string; contentType: string; data: Uint8Array }
export interface Message { subject: string; text: string; link?: string; severity?: "info" | "warn" | "critical"; attachments?: Attachment[] }
export type Fetch = typeof fetch;

export interface Providers {
  fetch: Fetch;
  /** Resend-compatible email API. */
  email?: { apiKey: string; from: string; url?: string } | null;
  /** Twilio SMS. */
  sms?: { accountSid: string; authToken: string; from: string; url?: string } | null;
}
export type Result = { ok: true } | { ok: false; error: string };

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Providers {
  return {
    fetch,
    email: env.RESEND_API_KEY && env.EMAIL_FROM ? { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, url: env.EMAIL_API_URL } : null,
    sms: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM, url: env.TWILIO_API_URL } : null,
  };
}

const PRIVATE = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;
/** Webhook addresses are set by customers and called by our server, so only public https addresses are allowed. */
export function isSafeWebhookUrl(raw: string): boolean {
  try { const u = new URL(raw); return u.protocol === "https:" && !u.username && !u.password && !PRIVATE.test(u.hostname); } catch { return false; }
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
        if (!p.email) return { ok: false, error: "email is not set up on this server (RESEND_API_KEY and EMAIL_FROM)" };
        res = await p.fetch(p.email.url ?? "https://api.resend.com/emails", {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.email.apiKey}` },
          body: JSON.stringify({ from: p.email.from, to: [ep.target], subject: m.subject, text: `${m.text}${m.link ? `\n\n${m.link}` : ""}`, attachments: (m.attachments ?? []).map((a) => ({ filename: a.name, content: Buffer.from(a.data).toString("base64") })) }),
        });
        break;
      }
      case "sms": {
        if (!p.sms) return { ok: false, error: "SMS is not set up on this server (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM)" };
        const body = new URLSearchParams({ From: p.sms.from, To: ep.target, Body: `${m.subject}: ${m.text}`.slice(0, 600) });
        res = await p.fetch(p.sms.url ?? `https://api.twilio.com/2010-04-01/Accounts/${p.sms.accountSid}/Messages.json`, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${p.sms.accountSid}:${p.sms.authToken}`).toString("base64")}` }, body,
        });
        break;
      }
    }
    return res.ok ? { ok: true } : { ok: false, error: `the service answered ${res.status}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
