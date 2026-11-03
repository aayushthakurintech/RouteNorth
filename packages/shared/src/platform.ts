/**
 * Pure helpers for integrations and the platform: map tiles, email-to-job, calendar feeds, accounting exports,
 * the import wizard and custom fields. Nothing here talks to the network or the database.
 */

// ---- map providers -------------------------------------------------------------------------------------------

export const MAP_PROVIDERS = ["osm", "maptiler", "mapbox", "here", "google"] as const;
export type MapProvider = (typeof MAP_PROVIDERS)[number];

export interface TileChoice { url: string | null; attribution: string; supported: boolean }

/** Raster tile URL for a provider. A custom URL (with {z}/{x}/{y}) always wins. Google has no tile URL we may use, so it falls back to OpenStreetMap. */
export function tileChoice(provider: string, key: string, custom = ""): TileChoice {
  const k = encodeURIComponent(key.trim());
  if (/^https:\/\/.+\{z\}.+\{x\}.+\{y\}/.test(custom.trim()) || /^https:\/\/.+\{z\}.+\{y\}.+\{x\}/.test(custom.trim())) return { url: custom.trim(), attribution: "", supported: true };
  if (provider === "maptiler" && k) return { url: `https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png?key=${k}`, attribution: "© MapTiler © OpenStreetMap contributors", supported: true };
  if (provider === "mapbox" && k) return { url: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}?access_token=${k}`, attribution: "© Mapbox © OpenStreetMap contributors", supported: true };
  if (provider === "here" && k) return { url: `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png8?apiKey=${k}`, attribution: "© HERE", supported: true };
  return { url: null, attribution: "© OpenStreetMap contributors", supported: provider === "osm" };
}

// ---- email to job --------------------------------------------------------------------------------------------

export interface InboundEmail { from?: string; subject?: string; text?: string }
export interface ParsedEmailJob {
  title: string; customerName: string | null; customerEmail: string | null; customerPhone: string | null;
  address: string | null; scheduledDate: string | null; type: "pickup" | "delivery"; notes: string | null;
}

const ADDRESS_LABEL = /^\s*(?:deliver(?:y)?(?:\s+address)?(?:\s+to)?|ship\s+to|address|adresse(?:\s+de\s+livraison)?|livrer\s+[àa]|pick-?\s?up(?:\s+(?:at|from|address))?|ramassage(?:\s+[àa])?)\s*[:\-–]\s*(.+?)\s*$/im;
const STREET_LINE = /^\s*(\d{1,6}[A-Za-z]?\s+[^\n,]{2,60}?\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|way|ln|lane|ct|court|cres|crescent|pl|place|hwy|highway|rue|boul|chemin|ch|av|rang)\b\.?[^\n]{0,60})\s*$/im;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Read a forwarded email as a job. Anything it cannot find is left empty for the office to fill in. */
export function parseEmailJob(mail: InboundEmail, today: string): ParsedEmailJob {
  const subject = (mail.subject ?? "").replace(/^\s*((?:re|fwd?|tr|rv)\s*:\s*)+/i, "").trim();
  const body = (mail.text ?? "").split(/\r?\n/).filter((l) => !/^\s*>/.test(l)).join("\n").split(/\n-- ?\n/)[0]!.trim();
  const from = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(mail.from ?? "");
  const email = (from?.[2] ?? /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(mail.from ?? "")?.[0] ?? "").trim() || null;
  const name = (from?.[1] ?? "").trim() || null;
  const text = `${subject}\n${body}`;
  const address = ADDRESS_LABEL.exec(body)?.[1] ?? STREET_LINE.exec(body)?.[1] ?? STREET_LINE.exec(subject)?.[1] ?? null;
  const ph = PHONE.exec(body);
  let date: string | null = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text)?.[1] ?? null;
  if (!date && /\b(today|aujourd['’]hui)\b/i.test(text)) date = today;
  if (!date && /\b(tomorrow|demain)\b/i.test(text)) date = addDays(today, 1);
  return {
    title: (subject || (address ? `Job at ${address}` : "Email job")).slice(0, 200),
    customerName: name, customerEmail: email, customerPhone: ph ? `${ph[1]}-${ph[2]}-${ph[3]}` : null,
    address: address ? address.slice(0, 300) : null, scheduledDate: date,
    type: /pick-?\s?up|ramass/i.test(subject) ? "pickup" : "delivery", notes: body ? body.slice(0, 2000) : null,
  };
}

// ---- calendar feed (iCalendar) -------------------------------------------------------------------------------

export interface IcsEvent { uid: string; start: Date; end: Date; summary: string; description?: string; location?: string }

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const bytes = (s: string) => new TextEncoder().encode(s).length;
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (bytes(rest) > 75) {
    let n = 75;
    while (bytes(rest.slice(0, n)) > 75) n--;
    out.push(rest.slice(0, n)); rest = " " + rest.slice(n);
  }
  out.push(rest);
  return out.join("\r\n");
}

/** A calendar file Google Calendar and Outlook can subscribe to. Times are in UTC. */
export function buildIcs(calName: string, events: IcsEvent[], now = new Date()): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//RouteNorth//Calendar//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${icsText(calName)}`];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${icsDate(now)}`, `DTSTART:${icsDate(e.start)}`, `DTEND:${icsDate(e.end)}`, `SUMMARY:${icsText(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ---- accounting export ---------------------------------------------------------------------------------------

export const ACCOUNTING_FORMATS = ["quickbooks", "xero", "sage"] as const;
export type AccountingFormat = (typeof ACCOUNTING_FORMATS)[number];
export interface InvoiceExportRow {
  number: string; customer: string | null; email: string | null; issuedOn: string; dueOn: string | null; currency: string; status: string;
  lines: { description?: string; qty?: number; unitPrice?: number; amount?: number }[]; subtotal: number; tax: number; total: number; taxName?: string;
}

const q = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = (cells: unknown[]) => cells.map(q).join(",");

/** One CSV row per invoice line, in the column order of each program's own import template. Check the column names against your account before importing. */
export function invoiceCsv(rows: InvoiceExportRow[], format: AccountingFormat): string {
  const out: string[] = [];
  const lines = (r: InvoiceExportRow) => (r.lines.length ? r.lines : [{ description: "Delivery services", qty: 1, unitPrice: r.subtotal, amount: r.subtotal }]);
  const amt = (l: { qty?: number; unitPrice?: number; amount?: number }) => l.amount ?? Math.round((l.qty ?? 1) * (l.unitPrice ?? 0) * 100) / 100;
  if (format === "quickbooks") {
    out.push(row(["*InvoiceNo", "*Customer", "*InvoiceDate", "*DueDate", "Terms", "Memo", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "*ItemAmount", "*ItemTaxCode", "Currency"]));
    for (const r of rows) for (const l of lines(r)) out.push(row([r.number, r.customer ?? "Customer", r.issuedOn, r.dueOn ?? r.issuedOn, "", "", "Delivery", l.description ?? "", l.qty ?? 1, l.unitPrice ?? amt(l), amt(l), r.tax > 0 ? "TAX" : "NON", r.currency]));
  } else if (format === "xero") {
    out.push(row(["*ContactName", "EmailAddress", "*InvoiceNumber", "*InvoiceDate", "*DueDate", "Description", "*Quantity", "*UnitAmount", "*AccountCode", "*TaxType", "Currency"]));
    for (const r of rows) for (const l of lines(r)) out.push(row([r.customer ?? "Customer", r.email ?? "", r.number, r.issuedOn, r.dueOn ?? r.issuedOn, l.description ?? "", l.qty ?? 1, l.unitPrice ?? amt(l), "200", r.tax > 0 ? (r.taxName ?? "Tax on Sales") : "Tax Exempt", r.currency]));
  } else {
    out.push(row(["Type", "Account Reference", "Date", "Invoice No", "Details", "Net Amount", "Tax Code", "Tax Amount", "Currency"]));
    for (const r of rows) {
      const ls = lines(r); const net = ls.reduce((s, l) => s + amt(l), 0);
      ls.forEach((l, i) => out.push(row(["SI", (r.customer ?? "CUSTOMER").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8), r.issuedOn, r.number, l.description ?? "", amt(l).toFixed(2), r.tax > 0 ? "T1" : "T0", i === 0 ? (net > 0 ? Math.round(r.tax * 100) / 100 : 0).toFixed(2) : "0.00", r.currency])));
    }
  }
  return out.join("\r\n") + "\r\n";
}

// ---- import wizard -------------------------------------------------------------------------------------------

export const JOB_IMPORT_FIELDS = ["title", "address", "customer_name", "customer_phone", "customer_email", "scheduled_date", "type", "priority", "notes", "weight_kg", "service_min", "ref"] as const;
export type JobImportField = (typeof JOB_IMPORT_FIELDS)[number];

/** Header names other tools use for the same thing. Matching ignores case, spaces and punctuation. */
const ALIASES: Record<JobImportField, string[]> = {
  title: ["title", "name", "task", "taskname", "job", "jobname", "description", "orderid", "ordername", "stopname", "stop"],
  address: ["address", "streetaddress", "deliveryaddress", "location", "destination", "fulladdress", "addressline1", "adresse"],
  customer_name: ["customername", "recipientname", "recipient", "customer", "contactname", "contact", "client", "nomduclient", "nom"],
  customer_phone: ["customerphone", "recipientphone", "phone", "phonenumber", "mobile", "telephone", "tel", "contactphone"],
  customer_email: ["customeremail", "recipientemail", "email", "emailaddress", "courriel"],
  scheduled_date: ["scheduleddate", "date", "deliverydate", "completeafterdate", "servicedate", "duedate"],
  type: ["type", "tasktype", "jobtype", "stoptype", "kind"],
  priority: ["priority", "urgency", "priorite"],
  notes: ["notes", "note", "instructions", "deliveryinstructions", "comments", "comment", "remarks"],
  weight_kg: ["weightkg", "weight", "load", "poids", "quantity"],
  service_min: ["servicemin", "servicetime", "serviceduration", "duration", "dwell", "durationmin"],
  ref: ["ref", "reference", "externalid", "id", "ordernumber", "trackingnumber", "orderno"],
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface ImportPreset { id: string; label: string; hints: Partial<Record<JobImportField, string[]>> }
/** Presets add the exact header names a tool is known to use. Exports change over time, so the mapping is always shown for checking. */
export const IMPORT_PRESETS: ImportPreset[] = [
  { id: "routenorth", label: "RouteNorth template", hints: {} },
  { id: "onfleet", label: "Onfleet", hints: { customer_name: ["recipientname"], customer_phone: ["recipientphone"], address: ["address"], notes: ["recipientnotes", "notes"], title: ["shortid"] } },
  { id: "routific", label: "Routific", hints: { title: ["name"], address: ["address"], service_min: ["duration"], notes: ["notes"] } },
  { id: "optimoroute", label: "OptimoRoute", hints: { title: ["orderno", "locationname"], address: ["address"], service_min: ["duration"], customer_phone: ["phone"], notes: ["notes"] } },
  { id: "generic", label: "Spreadsheet (any columns)", hints: {} },
];

/** Guess which column feeds which field. Each column is used once. Returns field → header (or "" when nothing fits). */
export function autoMap(headers: string[], presetId = "generic"): Record<JobImportField, string> {
  const preset = IMPORT_PRESETS.find((p) => p.id === presetId);
  const used = new Set<string>();
  const out = {} as Record<JobImportField, string>;
  for (const f of JOB_IMPORT_FIELDS) {
    const wanted = [...(preset?.hints[f] ?? []), ...ALIASES[f]];
    const hit = wanted.map((w) => headers.find((h) => norm(h) === norm(w) && !used.has(h))).find(Boolean);
    out[f] = hit ?? "";
    if (hit) used.add(hit);
  }
  return out;
}

/** Rows keyed by RouteNorth's own column names, ready for the CSV importer. Dates like 12/31/2026 become ISO dates. */
export function applyMapping(rows: Record<string, string>[], mapping: Partial<Record<JobImportField, string>>): Record<string, string>[] {
  return rows.map((r) => {
    const o: Record<string, string> = {};
    for (const f of JOB_IMPORT_FIELDS) {
      const h = mapping[f];
      let v = h ? (r[h] ?? "").trim() : "";
      if (f === "scheduled_date" && v) v = toIsoDate(v) ?? v;
      if (f === "type" && v) v = ({ pickup: "pickup", "pick up": "pickup", "pick-up": "pickup", collection: "pickup", delivery: "delivery", dropoff: "delivery", "drop off": "delivery", "drop-off": "delivery", service: "service", inspection: "inspection" } as Record<string, string>)[v.toLowerCase()] ?? v;
      if (f === "priority" && v) v = ({ low: "low", normal: "normal", medium: "normal", high: "high", urgent: "urgent", rush: "urgent" } as Record<string, string>)[v.toLowerCase()] ?? v;
      if (v) o[f] = v;
    }
    return o;
  });
}

function toIsoDate(s: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (!m) return null;
  let [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 12) [a, b] = [b, a]; // day/month
  if (a < 1 || a > 12 || b < 1 || b > 31) return null;
  return `${m[3]}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`;
}

/** Rows as CSV text for the jobs importer. */
export function rowsToCsv(rows: Record<string, string>[]): string {
  const cols = JOB_IMPORT_FIELDS.filter((f) => rows.some((r) => r[f]));
  return [row([...cols]), ...rows.map((r) => row(cols.map((c) => r[c] ?? "")))].join("\r\n") + "\r\n";
}

// ---- custom fields -------------------------------------------------------------------------------------------

export const CUSTOM_ENTITIES = ["job", "vehicle", "driver", "customer", "depot"] as const;
export type CustomEntity = (typeof CUSTOM_ENTITIES)[number];
export const CUSTOM_TYPES = ["text", "number", "date", "bool", "select"] as const;
export type CustomType = (typeof CUSTOM_TYPES)[number];
export interface CustomFieldDef { key: string; label: string; type: CustomType; options?: string[] | null; required?: boolean; active?: boolean }

/** Check values against the field definitions. Returns the cleaned values, or a message for the first problem. */
export function checkCustomValues(defs: CustomFieldDef[], input: Record<string, unknown>): { ok: true; values: Record<string, string | number | boolean | null> } | { ok: false; error: string } {
  const values: Record<string, string | number | boolean | null> = {};
  const byKey = new Map(defs.filter((d) => d.active !== false).map((d) => [d.key, d]));
  for (const k of Object.keys(input)) if (!byKey.has(k)) return { ok: false, error: `unknown field "${k}"` };
  for (const d of byKey.values()) {
    const raw = input[d.key];
    if (raw === undefined || raw === null || raw === "") {
      if (d.required && raw !== undefined) return { ok: false, error: `${d.label} is required` };
      if (raw !== undefined) values[d.key] = null;
      continue;
    }
    if (d.type === "number") { const n = Number(raw); if (!Number.isFinite(n)) return { ok: false, error: `${d.label} must be a number` }; values[d.key] = n; }
    else if (d.type === "bool") values[d.key] = raw === true || raw === "true";
    else if (d.type === "date") { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw)) || Number.isNaN(Date.parse(String(raw)))) return { ok: false, error: `${d.label} must be a date` }; values[d.key] = String(raw); }
    else if (d.type === "select") { if (!(d.options ?? []).includes(String(raw))) return { ok: false, error: `${d.label} must be one of ${(d.options ?? []).join(", ")}` }; values[d.key] = String(raw); }
    else { if (String(raw).length > 500) return { ok: false, error: `${d.label} is too long` }; values[d.key] = String(raw); }
  }
  return { ok: true, values };
}

// ---- integration catalog -------------------------------------------------------------------------------------

export type IntegrationMode = "built_in" | "api" | "webhook" | "feed" | "external";
export interface Integration { id: string; group: string; name: string; mode: IntegrationMode; item: string }

/** What can be connected today. "external" means it needs a vendor account or a partner build and is not built here. */
export const INTEGRATIONS: Integration[] = [
  { id: "api", group: "developers", name: "REST API with API keys", mode: "built_in", item: "integ.1" },
  { id: "webhooks", group: "developers", name: "Webhooks", mode: "built_in", item: "integ.2" },
  { id: "zapier", group: "automation", name: "Zapier", mode: "webhook", item: "integ.3" },
  { id: "make", group: "automation", name: "Make", mode: "webhook", item: "integ.3" },
  { id: "maptiler", group: "maps", name: "MapTiler", mode: "built_in", item: "integ.4" },
  { id: "mapbox", group: "maps", name: "Mapbox", mode: "built_in", item: "integ.4" },
  { id: "here", group: "maps", name: "HERE", mode: "built_in", item: "integ.4" },
  { id: "google_maps", group: "maps", name: "Google Maps", mode: "external", item: "integ.4" },
  { id: "quickbooks", group: "accounting", name: "QuickBooks", mode: "feed", item: "integ.5" },
  { id: "xero", group: "accounting", name: "Xero", mode: "feed", item: "integ.5" },
  { id: "sage", group: "accounting", name: "Sage", mode: "feed", item: "integ.5" },
  { id: "salesforce", group: "crm", name: "Salesforce", mode: "external", item: "integ.6" },
  { id: "hubspot", group: "crm", name: "HubSpot", mode: "api", item: "integ.6" },
  { id: "zoho", group: "crm", name: "Zoho", mode: "api", item: "integ.6" },
  { id: "shopify", group: "ecommerce", name: "Shopify", mode: "webhook", item: "integ.7" },
  { id: "woocommerce", group: "ecommerce", name: "WooCommerce", mode: "webhook", item: "integ.7" },
  { id: "amazon", group: "ecommerce", name: "Amazon", mode: "external", item: "integ.7" },
  { id: "etsy", group: "ecommerce", name: "Etsy", mode: "external", item: "integ.7" },
  { id: "sap", group: "erp", name: "SAP", mode: "external", item: "integ.8" },
  { id: "netsuite", group: "erp", name: "NetSuite", mode: "api", item: "integ.8" },
  { id: "odoo", group: "erp", name: "Odoo", mode: "api", item: "integ.8" },
  { id: "traccar", group: "telematics", name: "GPS trackers (Traccar protocols)", mode: "built_in", item: "integ.9" },
  { id: "geotab", group: "telematics", name: "Geotab", mode: "external", item: "integ.9" },
  { id: "samsara", group: "telematics", name: "Samsara", mode: "external", item: "integ.9" },
  { id: "fuelcards", group: "fuel", name: "Fuel cards and toll tags", mode: "external", item: "integ.10" },
  { id: "twilio", group: "messaging", name: "Twilio SMS", mode: "built_in", item: "integ.11" },
  { id: "sendgrid", group: "messaging", name: "Email (SendGrid-style API)", mode: "built_in", item: "integ.11" },
  { id: "whatsapp", group: "messaging", name: "WhatsApp Business", mode: "external", item: "integ.11" },
  { id: "slack", group: "chat", name: "Slack", mode: "webhook", item: "integ.12" },
  { id: "teams", group: "chat", name: "Microsoft Teams", mode: "webhook", item: "integ.12" },
  { id: "calendar", group: "calendar", name: "Google and Outlook calendar (subscribe)", mode: "feed", item: "integ.13" },
  { id: "stripe", group: "payments", name: "Stripe", mode: "external", item: "integ.14" },
  { id: "paypal", group: "payments", name: "PayPal", mode: "external", item: "integ.14" },
  { id: "email_job", group: "inbound", name: "Email to job", mode: "built_in", item: "integ.15" },
  { id: "sheets", group: "data", name: "Google Sheets and Excel", mode: "feed", item: "integ.16" },
  { id: "bi", group: "data", name: "Power BI, Tableau, Looker Studio, Metabase", mode: "feed", item: "integ.17" },
  { id: "warehouse", group: "data", name: "BigQuery, Snowflake, S3 (file export)", mode: "feed", item: "integ.18" },
  { id: "sso", group: "security", name: "Single sign-on (Google, Microsoft, Okta)", mode: "external", item: "integ.19" },
  { id: "weather", group: "data", name: "Weather", mode: "built_in", item: "integ.20" },
  { id: "traffic", group: "data", name: "Live traffic", mode: "external", item: "integ.20" },
];
