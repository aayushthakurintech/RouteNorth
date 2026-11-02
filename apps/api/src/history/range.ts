import { BadRequestException } from "@nestjs/common";

export interface Range { from: Date; to: Date }

const DAY_MS = 86_400_000;

/** Parse and validate ?from=&to= (ISO 8601). Defaults to the last 24 hours. */
export function parseRange(from: unknown, to: unknown, maxDays: number, now = new Date()): Range {
  const toDate = to === undefined ? now : new Date(String(to));
  const fromDate = from === undefined ? new Date(toDate.getTime() - DAY_MS) : new Date(String(from));
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new BadRequestException("from and to must be ISO 8601 timestamps");
  }
  if (fromDate >= toDate) throw new BadRequestException("from must be before to");
  if (toDate.getTime() - fromDate.getTime() > maxDays * DAY_MS) {
    throw new BadRequestException(`range cannot exceed ${maxDays} days`);
  }
  return { from: fromDate, to: toDate };
}

export function parseTimeZone(tz: unknown): string {
  if (tz === undefined) return "America/Toronto";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: String(tz) });
    return String(tz);
  } catch {
    throw new BadRequestException("unknown time zone");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseUuid(id: string): string {
  if (!UUID.test(id)) throw new BadRequestException("invalid id");
  return id;
}
