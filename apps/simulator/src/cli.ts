import { DEFAULT_FLEET } from "./routes.js";
import { initialState, step, type SimState, type SimVehicle } from "./vehicle.js";

/**
 * Drives simulated vehicles and reports them to Traccar over the OsmAnd protocol
 * (the same path a real tracker takes, minus the radio).
 *   TRACCAR_URL  default http://localhost:5055
 *   TICK_SECONDS default 5   (how often a fix is sent)
 *   SPEEDUP      default 1   (simulated seconds per real second)
 */
const traccar = process.env.TRACCAR_URL ?? "http://localhost:5055";
const tick = Number(process.env.TICK_SECONDS ?? 5);
const speedup = Number(process.env.SPEEDUP ?? 1);

const states = new Map<string, SimState>(DEFAULT_FLEET.map((v) => [v.id, initialState(v)]));

async function send(v: SimVehicle, s: SimState): Promise<void> {
  const q = new URLSearchParams({
    id: v.id,
    lat: s.position.lat.toFixed(6),
    lon: s.position.lng.toFixed(6),
    speed: (s.speedKmh / 1.852).toFixed(1), // OsmAnd speed is in knots
    bearing: s.heading.toFixed(0),
    timestamp: String(Math.floor(Date.now() / 1000)),
    ignition: "true",
    totalDistance: s.odometer.toFixed(0),
  });
  const res = await fetch(`${traccar}/?${q}`, { method: "POST" });
  if (!res.ok) console.error(`${v.id}: traccar replied ${res.status}`);
}

console.log(`simulating ${DEFAULT_FLEET.length} vehicles -> ${traccar} every ${tick}s (x${speedup})`);
setInterval(() => {
  for (const v of DEFAULT_FLEET) {
    const next = step(v, states.get(v.id)!, tick * speedup);
    states.set(v.id, next);
    send(v, next).catch((e) => console.error(`${v.id}: ${e.message}`));
  }
}, tick * 1000);
