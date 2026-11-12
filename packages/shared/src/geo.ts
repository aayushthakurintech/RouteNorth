const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres between two lat/lng points. */
export function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** A polygon is a list of [lat, lng] corners (not closed: the last corner joins the first). */
export type Polygon = readonly (readonly [number, number])[];

/** Ray casting: is the point inside the polygon? Points exactly on an edge may go either way. */
export function pointInPolygon(lat: number, lng: number, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i]!;
    const [yj, xj] = poly[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface ShapeLike {
  shape: "circle" | "polygon";
  lat?: number | null;
  lng?: number | null;
  radiusM?: number | null;
  polygon?: Polygon | null;
}

/** Is the point inside a geofence (circle or polygon)? */
export function insideShape(g: ShapeLike, lat: number, lng: number): boolean {
  if (g.shape === "circle") {
    return g.lat != null && g.lng != null && g.radiusM != null && haversine(g.lat, g.lng, lat, lng) <= g.radiusM;
  }
  return !!g.polygon && g.polygon.length >= 3 && pointInPolygon(lat, lng, g.polygon);
}

/** Centre of a bounding box around the points, handy for placing labels. */
export function centroid(points: readonly (readonly [number, number])[]): [number, number] {
  if (points.length === 0) return [0, 0];
  let la = 0, lo = 0;
  for (const [a, b] of points) { la += a; lo += b; }
  return [la / points.length, lo / points.length];
}
