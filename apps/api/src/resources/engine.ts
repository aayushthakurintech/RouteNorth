import { BadRequestException } from "@nestjs/common";
import type { Field, ResourceDef } from "./defs.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JSON = 200_000;

/** Validate one value for a field. `undefined` means "not supplied"; null means "clear it". */
export function parseValue(f: Field, raw: unknown): unknown {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") {
    if (f.required) throw new BadRequestException(`${f.key} is required`);
    return null;
  }
  switch (f.type) {
    case "text": {
      if (typeof raw !== "string") throw new BadRequestException(`${f.key} must be text`);
      const s = raw.trim();
      if (f.required && !s) throw new BadRequestException(`${f.key} is required`);
      if (s.length > (f.max ?? 300)) throw new BadRequestException(`${f.key} is too long`);
      return s || null;
    }
    case "int":
    case "num": {
      const x = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof x !== "number" || !Number.isFinite(x)) throw new BadRequestException(`${f.key} must be a number`);
      if (f.min !== undefined && x < f.min) throw new BadRequestException(`${f.key} must be at least ${f.min}`);
      if (f.max !== undefined && x > f.max) throw new BadRequestException(`${f.key} must be at most ${f.max}`);
      if (f.type === "int" && !Number.isInteger(x)) throw new BadRequestException(`${f.key} must be a whole number`);
      return x;
    }
    case "bool":
      if (typeof raw !== "boolean") throw new BadRequestException(`${f.key} must be true or false`);
      return raw;
    case "date":
      if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(new Date(raw).getTime())) throw new BadRequestException(`${f.key} must be YYYY-MM-DD`);
      return raw;
    case "time":
      if (typeof raw !== "string" || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(raw)) throw new BadRequestException(`${f.key} must be HH:MM`);
      return raw;
    case "ts": {
      const dt = new Date(String(raw));
      if (Number.isNaN(dt.getTime())) throw new BadRequestException(`${f.key} must be an ISO 8601 timestamp`);
      return dt.toISOString();
    }
    case "enum":
      if (typeof raw !== "string" || !f.values!.includes(raw)) throw new BadRequestException(`${f.key} must be one of ${f.values!.join(", ")}`);
      return raw;
    case "ref":
      if (typeof raw !== "string" || !UUID.test(raw)) throw new BadRequestException(`${f.key} must be an id`);
      return raw;
    case "tags": {
      if (!Array.isArray(raw) || raw.length > 50 || raw.some((x) => typeof x !== "string" || x.length === 0 || x.length > 60)) {
        throw new BadRequestException(`${f.key} must be a list of short text values`);
      }
      return [...new Set((raw as string[]).map((x) => x.trim()).filter(Boolean))];
    }
    case "json": {
      const ok = f.json === "object" ? typeof raw === "object" && !Array.isArray(raw) : Array.isArray(raw);
      if (!ok) throw new BadRequestException(`${f.key} must be ${f.json === "object" ? "an object" : "a list"}`);
      if (JSON.stringify(raw).length > MAX_JSON) throw new BadRequestException(`${f.key} is too large`);
      return raw;
    }
  }
}

/** Validate a request body against a resource. On create, required fields must be present. */
export function parseBody(def: ResourceDef, body: unknown, creating: boolean): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequestException("body must be an object");
  const o = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (creating && f.required && (o[f.key] === undefined || o[f.key] === null || o[f.key] === "")) throw new BadRequestException(`${f.key} is required`);
    const v = parseValue(f, o[f.key]);
    if (v !== undefined) out[f.key] = v;
  }
  const unknown = Object.keys(o).filter((k) => !def.fields.some((f) => f.key === k));
  if (unknown.length) throw new BadRequestException(`unknown field: ${unknown.slice(0, 3).join(", ")}`);
  return out;
}

export const selectList = (def: ResourceDef, withHeavy = false): string =>
  [`${def.table}.id`, ...def.fields.filter((f) => withHeavy || !f.heavy).map((f) =>
    `${def.table}.${f.col}${f.type === "date" || f.type === "time" ? "::text" : ""} AS "${f.key}"`)].join(", ");

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Spreadsheet programs run cells that start with = + - @ as formulas; prefix them.
  const safe = /^[=+@]|^-(?![\d.])/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
