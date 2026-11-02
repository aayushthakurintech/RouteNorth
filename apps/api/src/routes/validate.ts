import { BadRequestException } from "@nestjs/common";

export interface StopInput {
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  radiusM: number;
  windowStart: string | null;
  windowEnd: string | null;
  packages: number;
  notes: string | null;
}

export const MAX_STOPS_PER_ROUTE = 500;

function str(v: unknown, field: string, max: number, required = false): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new BadRequestException(`${field} is required`);
    return null;
  }
  if (typeof v !== "string") throw new BadRequestException(`${field} must be text`);
  const s = v.trim();
  if (required && !s) throw new BadRequestException(`${field} is required`);
  if (s.length > max) throw new BadRequestException(`${field} is too long`);
  return s || null;
}

function num(v: unknown, field: string, min: number, max: number, dflt?: number): number {
  if ((v === undefined || v === null || v === "") && dflt !== undefined) return dflt;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) {
    throw new BadRequestException(`${field} must be a number between ${min} and ${max}`);
  }
  return n;
}

function time(v: unknown, field: string): string | null {
  const s = str(v, field, 40);
  if (s === null) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} must be an ISO 8601 timestamp`);
  return d.toISOString();
}

/** Validate one stop from JSON or CSV (CSV values arrive as strings). */
export function parseStopInput(raw: unknown): StopInput {
  if (typeof raw !== "object" || raw === null) throw new BadRequestException("stop must be an object");
  const o = raw as Record<string, unknown>;
  const windowStart = time(o.windowStart ?? o.window_start, "windowStart");
  const windowEnd = time(o.windowEnd ?? o.window_end, "windowEnd");
  if (windowStart && windowEnd && windowEnd <= windowStart) {
    throw new BadRequestException("windowEnd must be after windowStart");
  }
  return {
    name: str(o.name, "name", 200, true)!,
    address: str(o.address, "address", 300),
    lat: num(o.lat, "lat", -90, 90),
    lng: num(o.lng, "lng", -180, 180),
    radiusM: Math.round(num(o.radiusM ?? o.radius_m, "radiusM", 10, 1000, 75)),
    windowStart,
    windowEnd,
    packages: Math.round(num(o.packages, "packages", 0, 100_000, 0)),
    notes: str(o.notes, "notes", 1000),
  };
}

export function parseDate(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v).getTime())) {
    throw new BadRequestException("date must be YYYY-MM-DD");
  }
  return v;
}

export function parseName(v: unknown): string {
  return str(v, "name", 200, true)!;
}
