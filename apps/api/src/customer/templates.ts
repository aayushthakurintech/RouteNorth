import { CUSTOMER_EVENTS, render, type CustomerEvent } from "../automation/spec.js";

/**
 * What customers read. Every message exists in English and French, as a short text (SMS) and a fuller email. An organization can
 * replace any of them (message_templates); placeholders such as {{customer}} and {{link}} are filled in when the message is sent.
 */
export type Locale = "en" | "fr";
export type Channel = "email" | "sms";
export interface Text { subject: string; sms: string; email: string }

export const DEFAULTS: Record<CustomerEvent, Record<Locale, Text>> = {
  received: {
    en: { subject: "We received your order", sms: "{{org}}: we received your order {{ref}}. Follow it here: {{link}}", email: "Hello {{customer}},\n\nWe received your order {{ref}} ({{title}}). We will let you know when it is scheduled.\n\nYou can follow it, change the time or leave instructions here:" },
    fr: { subject: "Nous avons reçu votre commande", sms: "{{org}} : nous avons reçu votre commande {{ref}}. Suivez-la ici : {{link}}", email: "Bonjour {{customer}},\n\nNous avons bien reçu votre commande {{ref}} ({{title}}). Nous vous préviendrons dès qu’elle sera planifiée.\n\nVous pouvez la suivre, changer l’heure ou laisser des instructions ici :" },
  },
  scheduled: {
    en: { subject: "Your delivery is scheduled", sms: "{{org}}: your delivery {{ref}} is scheduled {{window}}. Track it: {{link}}", email: "Hello {{customer}},\n\nYour delivery {{ref}} ({{title}}) is scheduled {{window}}.\n\nTrack it, change the time or leave instructions here:" },
    fr: { subject: "Votre livraison est planifiée", sms: "{{org}} : votre livraison {{ref}} est planifiée {{window}}. Suivi : {{link}}", email: "Bonjour {{customer}},\n\nVotre livraison {{ref}} ({{title}}) est planifiée {{window}}.\n\nSuivez-la, changez l’heure ou laissez des instructions ici :" },
  },
  on_the_way: {
    en: { subject: "Your driver is on the way", sms: "{{org}}: your driver{{driverWith}} is on the way with {{ref}}. Follow live: {{link}}", email: "Hello {{customer}},\n\nYour driver{{driverWith}} is on the way with {{ref}} ({{title}}).\n\nFollow them live here:" },
    fr: { subject: "Votre chauffeur est en route", sms: "{{org}} : votre chauffeur{{driverWith}} est en route avec {{ref}}. Suivi en direct : {{link}}", email: "Bonjour {{customer}},\n\nVotre chauffeur{{driverWith}} est en route avec {{ref}} ({{title}}).\n\nSuivez-le en direct ici :" },
  },
  minutes_away: {
    en: { subject: "Your driver is about {{minutes}} minutes away", sms: "{{org}}: your driver is about {{minutes}} minutes away. {{link}}", email: "Hello {{customer}},\n\nYour driver is about {{minutes}} minutes away with {{ref}}. Please be ready to receive it.\n\nFollow them live here:" },
    fr: { subject: "Votre chauffeur arrive dans environ {{minutes}} minutes", sms: "{{org}} : votre chauffeur arrive dans environ {{minutes}} minutes. {{link}}", email: "Bonjour {{customer}},\n\nVotre chauffeur arrive dans environ {{minutes}} minutes avec {{ref}}. Merci d’être prêt à le recevoir.\n\nSuivez-le en direct ici :" },
  },
  stops_away: {
    en: { subject: "Your driver is {{stops}} stops away", sms: "{{org}}: your driver is {{stops}} stops away. {{link}}", email: "Hello {{customer}},\n\nYour driver is {{stops}} stops away from you.\n\nFollow them live here:" },
    fr: { subject: "Votre chauffeur est à {{stops}} arrêts", sms: "{{org}} : votre chauffeur est à {{stops}} arrêts de chez vous. {{link}}", email: "Bonjour {{customer}},\n\nVotre chauffeur est à {{stops}} arrêts de chez vous.\n\nSuivez-le en direct ici :" },
  },
  arrived: {
    en: { subject: "Your driver has arrived", sms: "{{org}}: your driver has arrived. {{link}}", email: "Hello {{customer}},\n\nYour driver has arrived with {{ref}}.\n\nDetails:" },
    fr: { subject: "Votre chauffeur est arrivé", sms: "{{org}} : votre chauffeur est arrivé. {{link}}", email: "Bonjour {{customer}},\n\nVotre chauffeur est arrivé avec {{ref}}.\n\nDétails :" },
  },
  delivered: {
    en: { subject: "Delivered: {{title}}", sms: "{{org}}: {{ref}} was delivered. See the proof and rate it: {{link}}", email: "Hello {{customer}},\n\n{{ref}} ({{title}}) was delivered. Thank you!\n\nSee the proof of delivery and tell us how it went:" },
    fr: { subject: "Livré : {{title}}", sms: "{{org}} : {{ref}} a été livré. Voir la preuve et noter : {{link}}", email: "Bonjour {{customer}},\n\n{{ref}} ({{title}}) a été livré. Merci !\n\nConsultez la preuve de livraison et dites-nous comment cela s’est passé :" },
  },
  failed: {
    en: { subject: "We could not deliver {{title}}", sms: "{{org}}: we could not deliver {{ref}} ({{reason}}). Pick a new time: {{link}}", email: "Hello {{customer}},\n\nWe could not deliver {{ref}} ({{title}}). Reason: {{reason}}.\n\nYou can choose a new time here:" },
    fr: { subject: "Nous n’avons pas pu livrer {{title}}", sms: "{{org}} : nous n’avons pas pu livrer {{ref}} ({{reason}}). Choisissez une nouvelle heure : {{link}}", email: "Bonjour {{customer}},\n\nNous n’avons pas pu livrer {{ref}} ({{title}}). Motif : {{reason}}.\n\nVous pouvez choisir une nouvelle heure ici :" },
  },
  rescheduled: {
    en: { subject: "Your delivery was rescheduled", sms: "{{org}}: your delivery {{ref}} was rescheduled {{window}}. {{link}}", email: "Hello {{customer}},\n\nYour delivery {{ref}} ({{title}}) was rescheduled {{window}}.\n\nDetails:" },
    fr: { subject: "Votre livraison a été reportée", sms: "{{org}} : votre livraison {{ref}} a été reportée {{window}}. {{link}}", email: "Bonjour {{customer}},\n\nVotre livraison {{ref}} ({{title}}) a été reportée {{window}}.\n\nDétails :" },
  },
  cancelled: {
    en: { subject: "Your order was cancelled", sms: "{{org}}: your order {{ref}} was cancelled. {{link}}", email: "Hello {{customer}},\n\nYour order {{ref}} ({{title}}) was cancelled.\n\nDetails:" },
    fr: { subject: "Votre commande a été annulée", sms: "{{org}} : votre commande {{ref}} a été annulée. {{link}}", email: "Bonjour {{customer}},\n\nVotre commande {{ref}} ({{title}}) a été annulée.\n\nDétails :" },
  },
};

export const isCustomerEvent = (x: unknown): x is CustomerEvent => typeof x === "string" && (CUSTOMER_EVENTS as readonly string[]).includes(x);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface Brand { name: string; color: string | null }
export interface Rendered { subject: string; text: string; html: string; sms: string }

/**
 * Build one message. `custom` is the organization's own wording for this event, channel and language (if it has one).
 * The link is added under the email text as a button, and inside the SMS wording through {{link}}.
 */
export function renderCustomerMessage(event: CustomerEvent | "custom", locale: Locale, vars: Record<string, string>, brand: Brand, custom?: { email?: { subject?: string | null; body: string }; sms?: { body: string } }, freeText?: string): Rendered {
  const d = event === "custom" ? null : DEFAULTS[event][locale];
  const subject = render(custom?.email?.subject || d?.subject || vars.org || "", vars);
  const emailBody = render(freeText ?? custom?.email?.body ?? d?.email ?? "", vars);
  const sms = render(freeText ? `{{org}}: ${freeText} {{link}}` : custom?.sms?.body ?? d?.sms ?? "", vars).replace(/\s+/g, " ").trim();
  const color = brand.color && /^#[0-9a-f]{6}$/i.test(brand.color) ? brand.color : "#1d4ed8";
  const label = locale === "fr" ? "Ouvrir le suivi" : "Open tracking page";
  const paragraphs = emailBody.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.5">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const button = vars.link ? `<p style="margin:20px 0"><a href="${esc(vars.link)}" style="background:${color};color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${label}</a></p>` : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1d21"><div style="max-width:560px;margin:0 auto"><div style="background:${color};color:#fff;padding:18px 24px;font-size:18px;font-weight:700">${esc(brand.name)}</div><div style="background:#fff;padding:24px">${paragraphs}${button}</div><div style="padding:14px 24px;font-size:12px;color:#6b7280">${esc(brand.name)}</div></div></body></html>`;
  return { subject, text: `${emailBody}${vars.link ? `\n\n${vars.link}` : ""}`, html, sms };
}
