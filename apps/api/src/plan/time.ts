/** Milliseconds since the epoch for a local date and time in an IANA time zone (e.g. 2026-06-01 08:00 in America/Toronto). */
export function zonedToEpoch(date: string, hhmm: string, timeZone: string): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Find the zone's offset at that moment, then correct once more for daylight-saving edges.
  const offset = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - ms;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

/** Local hour (0 to 23) of an instant in a time zone. */
export function hourIn(timeZone: string): (ms: number) => number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit" });
  return (ms) => Number(f.format(new Date(ms)));
}
