import { strToU8, zipSync } from "fflate";
import PDFDocument from "pdfkit";
import type { Insight } from "../analytics/insights.js";
import type { Metrics } from "../analytics/analytics.service.js";
import type { ReportResult } from "./datasets.js";

export interface Brand { name: string; color: string | null; logoDataUrl: string | null }
type Labels = Record<string, string>;

const csvCell = (v: unknown) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`; // stop spreadsheets running formulas from data
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(r: Pick<ReportResult, "columns" | "rows">, labels: Labels = {}): string {
  const head = r.columns.map((c) => csvCell(labels[c.key] ?? c.label)).join(",");
  const body = r.rows.map((row) => r.columns.map((c) => csvCell(row[c.key])).join(","));
  return `﻿${[head, ...body].join("\r\n")}`;
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const colName = (i: number) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** A real .xlsx file (opens in Excel, Numbers, Google Sheets): one sheet, bold header row, numbers stay numbers. */
export function toXlsx(r: Pick<ReportResult, "columns" | "rows">, sheetName = "Report", labels: Labels = {}): Uint8Array {
  const rows: string[] = [];
  const cell = (ref: string, v: unknown, style = 0) =>
    typeof v === "number" && Number.isFinite(v) ? `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${v}</v></c>` : v == null || v === "" ? "" : `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
  rows.push(`<row r="1">${r.columns.map((c, i) => cell(`${colName(i)}1`, labels[c.key] ?? c.label, 1)).join("")}</row>`);
  r.rows.forEach((row, ri) => rows.push(`<row r="${ri + 2}">${r.columns.map((c, i) => cell(`${colName(i)}${ri + 2}`, row[c.key])).join("")}</row>`));
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Report")}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${rows.join("")}</sheetData></worksheet>`),
  };
  return zipSync(files);
}

const hex = (c: string | null, fallback = "#0f5fa8") => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback);
function logoBuffer(url: string | null): Buffer | null {
  const m = url ? /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(url) : null;
  return m ? Buffer.from(m[2]!, "base64") : null;
}
function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((ok, fail) => { const parts: Buffer[] = []; doc.on("data", (d: Buffer) => parts.push(d)); doc.on("end", () => ok(Buffer.concat(parts))); doc.on("error", fail); doc.end(); });
}
function header(doc: PDFKit.PDFDocument, brand: Brand, title: string, sub: string) {
  const color = hex(brand.color);
  doc.rect(0, 0, doc.page.width, 64).fill(color);
  let x = 36;
  const logo = logoBuffer(brand.logoDataUrl);
  if (logo) { try { doc.image(logo, x, 14, { fit: [80, 36] }); x += 92; } catch { /* a bad logo should not break the report */ } }
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(16).text(brand.name, x, 16, { width: doc.page.width - x - 36 });
  doc.font("Helvetica").fontSize(10).text(title, x, 38, { width: doc.page.width - x - 36 });
  doc.fillColor("#475569").fontSize(9).text(sub, 36, 74);
  doc.fillColor("#0f172a");
  return color;
}

/** A branded PDF: logo and colour band, title and period, a small bar chart when the report is grouped, then the table. */
export async function toPdf(r: Pick<ReportResult, "columns" | "rows" | "totals" | "range">, o: { brand: Brand; title: string; labels?: Labels; footer?: string }): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", layout: r.columns.length > 6 ? "landscape" : "portrait", margin: 36, info: { Title: o.title, Producer: "RouteNorth" } });
  const out = collect(doc);
  const color = header(doc, o.brand, o.title, `${r.range.from} – ${r.range.to}   ·   ${r.rows.length} rows`);
  const labels = o.labels ?? {};
  const W = doc.page.width - 72;
  const cols = r.columns.slice(0, 12);
  const first = cols.find((c) => c.type === "num" || c.type === "pct");
  const labelCol = cols.find((c) => c.type === "text" || c.type === "date");
  let y = 96;
  if (first && labelCol && r.rows.length >= 2 && r.rows.length <= 15) {
    const vals = r.rows.map((row) => Number(row[first.key]) || 0);
    const max = Math.max(...vals, 1e-9);
    doc.font("Helvetica-Bold").fontSize(9).text(labels[first.key] ?? first.label, 36, y); y += 14;
    r.rows.forEach((row, i) => {
      doc.font("Helvetica").fontSize(8).fillColor("#334155").text(String(row[labelCol.key] ?? "").slice(0, 24), 36, y + 1, { width: 120 });
      doc.rect(160, y, Math.max(1, ((W - 220) * vals[i]!) / max), 9).fill(color);
      doc.fillColor("#0f172a").text(String(vals[i]), 164 + ((W - 220) * vals[i]!) / max, y + 1);
      y += 13;
    });
    y += 8;
  }
  const cw = W / cols.length;
  const row = (cells: string[], bold: boolean, shade: boolean) => {
    if (y > doc.page.height - 56) { doc.addPage(); y = 36; }
    if (shade) doc.rect(36, y - 2, W, 14).fill("#f1f5f9");
    doc.fillColor("#0f172a").font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
    cells.forEach((c, i) => doc.text(c.slice(0, Math.max(6, Math.floor(cw / 4.2))), 38 + i * cw, y, { width: cw - 4, lineBreak: false }));
    y += 14;
  };
  row(cols.map((c) => labels[c.key] ?? c.label), true, true);
  r.rows.slice(0, 1000).forEach((rw, i) => row(cols.map((c) => (rw[c.key] == null ? "" : String(rw[c.key]))), false, i % 2 === 1));
  if (Object.keys(r.totals).length) row(cols.map((c, i) => (i === 0 ? labels.total ?? "Total" : r.totals[c.key] != null ? String(r.totals[c.key]) : "")), true, false);
  const range = doc.bufferedPageRange?.();
  void range;
  doc.fontSize(7).fillColor("#64748b").text(o.footer ?? `Generated by RouteNorth for ${o.brand.name} on ${new Date().toISOString().slice(0, 10)}`, 36, doc.page.height - 30, { lineBreak: false });
  return out;
}

const KPI_TILES: [string, string, string, string, "up" | "down"][] = [
  ["onTimeRate", "On-time rate", "Taux de ponctualité", "%", "up"], ["stopsDone", "Stops completed", "Arrêts terminés", "", "up"], ["failedStops", "Failed stops", "Arrêts échoués", "", "down"],
  ["avgDelayMin", "Average delay", "Retard moyen", " min", "down"], ["distanceKm", "Distance", "Distance", " km", "up"], ["costTotal", "Estimated cost", "Coût estimé", " $", "down"],
  ["costPerStop", "Cost per stop", "Coût par arrêt", " $", "down"], ["idleSharePct", "Idle share", "Part de ralenti", "%", "down"], ["utilizationPct", "Fleet utilization", "Utilisation de la flotte", "%", "up"],
  ["lPer100", "Fuel L/100 km", "Carburant L/100 km", "", "down"], ["csat", "Customer rating (of 5)", "Satisfaction (sur 5)", "", "up"], ["incidents", "Incidents", "Incidents", "", "down"],
];
const INSIGHT_TEXT: Record<Insight["type"], [string, string]> = {
  routeLate: ["{route} was late on {late} of the last {days} days.", "{route} a été en retard {late} jour(s) sur les {days} derniers."],
  costJump: ["{route} cost {pct}% more than usual.", "{route} a coûté {pct} % de plus que d’habitude."],
  idleHigh: ["{driver} idles {pct}% of engine time (fleet: {fleet}%).", "{driver} est au ralenti {pct} % du temps moteur (flotte : {fleet} %)."],
  onTimeChange: ["On-time rate moved from {before}% to {now}%.", "Le taux de ponctualité est passé de {before} % à {now} %."],
  failedRising: ["Failed stops rose from {before} to {now}.", "Les arrêts échoués sont passés de {before} à {now}."],
  driverSafety: ["{driver} had {n} harsh driving events.", "{driver} a eu {n} événements de conduite brusque."],
  allGood: ["Nothing unusual this period.", "Rien d’inhabituel pour cette période."],
};
export const insightText = (i: Insight, lang: "en" | "fr") => INSIGHT_TEXT[i.type][lang === "fr" ? 1 : 0].replace(/\{(\w+)\}/g, (_, k: string) => String(i.params[k] ?? ""));

/** The executive summary: one page with the headline numbers, how they changed, and what stands out. */
export async function executivePdf(o: { brand: Brand; range: { from: string; to: string }; metrics: Metrics; previous?: Metrics | null; insights: Insight[]; lang: "en" | "fr" }): Promise<Buffer> {
  const fr = o.lang === "fr";
  const doc = new PDFDocument({ size: "LETTER", margin: 36, info: { Title: fr ? "Sommaire exécutif" : "Executive summary", Producer: "RouteNorth" } });
  const out = collect(doc);
  const color = header(doc, o.brand, fr ? "Sommaire exécutif" : "Executive summary", `${o.range.from} – ${o.range.to}`);
  const W = doc.page.width - 72, tw = (W - 20) / 3, th = 70;
  KPI_TILES.forEach(([k, en, frl, unit, good], i) => {
    const x = 36 + (i % 3) * (tw + 10), y = 100 + Math.floor(i / 3) * (th + 10);
    doc.roundedRect(x, y, tw, th, 6).lineWidth(1).stroke("#cbd5e1");
    doc.fillColor("#475569").font("Helvetica").fontSize(9).text(fr ? frl : en, x + 10, y + 8, { width: tw - 20 });
    const v = o.metrics[k];
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(20).text(v == null ? "—" : `${v}${unit.trim() === "$" ? " $" : unit}`, x + 10, y + 24, { width: tw - 20 });
    const p = o.previous?.[k];
    if (v != null && p != null && p !== 0) {
      const ch = Math.round(((v - p) / Math.abs(p)) * 1000) / 10;
      const better = good === "up" ? ch > 0 : ch < 0;
      doc.font("Helvetica").fontSize(9).fillColor(ch === 0 ? "#64748b" : better ? "#15803d" : "#b91c1c").text(`${ch > 0 ? "▲" : ch < 0 ? "▼" : "•"} ${Math.abs(ch)}%`, x + 10, y + 52);
    }
  });
  let y = 100 + 4 * (th + 10) + 10;
  doc.fillColor(color).font("Helvetica-Bold").fontSize(12).text(fr ? "À retenir" : "What stands out", 36, y); y += 20;
  doc.fillColor("#0f172a").font("Helvetica").fontSize(10);
  for (const i of o.insights.slice(0, 8)) { doc.text(`• ${insightText(i, o.lang)}`, 40, y, { width: W - 8 }); y = doc.y + 4; }
  doc.fontSize(7).fillColor("#64748b").text(`RouteNorth · ${new Date().toISOString().slice(0, 10)}`, 36, doc.page.height - 30, { lineBreak: false });
  return out;
}
