/** Deep links that open the driver's own navigation app with the stop as destination. */
export function navigationLinks(lat: number, lng: number) {
  const ll = `${lat},${lng}`;
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${ll}`,
    apple: `https://maps.apple.com/?daddr=${ll}`,
    waze: `https://waze.com/ul?ll=${ll}&navigate=yes`,
  };
}

/** The first stop that is not finished is the one to drive to next. */
export function nextStopIndex(stops: { status: string }[]): number {
  return stops.findIndex((s) => s.status === "pending" || s.status === "arrived");
}

/** Pick a size that keeps the longest side at or under `max`, never enlarging. */
export function scaledSize(w: number, h: number, max = 1600): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.round(w * k), height: Math.round(h * k) };
}
