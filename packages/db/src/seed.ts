import { randomBytes, scryptSync } from "node:crypto";
import { seedHistory } from "./history.js";
import { migrate, pg } from "./index.js";

/**
 * Sets up a local demo: applies migrations, creates the low-privilege `routenorth_app` role the
 * services connect as, and adds one demo organization with users, vehicles and today's route.
 * Safe to run again (existing data is kept; a missing route for today is added).
 *
 *   DATABASE_URL       superuser URL (default: the docker compose database)
 *   APP_DB_PASSWORD    password for routenorth_app   (default routenorth_app)
 *   DEMO_PASSWORD      password for the demo users   (default routenorth-demo)
 */
const url = process.env.DATABASE_URL ?? "postgres://routenorth:routenorth@localhost:5432/routenorth";
const appPassword = process.env.APP_DB_PASSWORD ?? "routenorth_app";
const demoPassword = process.env.DEMO_PASSWORD ?? "routenorth-demo";

// Same format as apps/api/src/passwords.ts: scrypt$<salt hex>$<key hex>
function hash(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`;
}

await migrate(url);
const pool = new pg.Pool({ connectionString: url });
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

await q(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    CREATE ROLE routenorth_app LOGIN;
  END IF;
END $$`);
await q(`ALTER ROLE routenorth_app PASSWORD '${appPassword.replace(/'/g, "''")}'`);
await q("GRANT USAGE ON SCHEMA public TO routenorth_app");
await q("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO routenorth_app");
await q("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO routenorth_app");
await q("GRANT EXECUTE ON FUNCTION resolve_device(text, text), find_login(text), all_org_ids(), due_provider_connections(int) TO routenorth_app");

let org = (await q("SELECT id FROM organizations WHERE name = 'Demo Fleet Co'")).rows[0]?.id as string | undefined;
if (!org) {
  org = (await q("INSERT INTO organizations (name) VALUES ('Demo Fleet Co') RETURNING id")).rows[0].id as string;
  for (const [email, role] of [["owner@demo.ca", "owner"], ["dispatcher@demo.ca", "dispatcher"], ["manager@demo.ca", "manager"], ["driver@demo.ca", "driver"], ["viewer@demo.ca", "viewer"]]) {
    await q("INSERT INTO users (org_id, email, password_hash, role) VALUES ($1, $2, $3, $4)", [org, email, hash(demoPassword), role]);
  }
  // external_id matches the ids the simulator reports (apps/simulator/src/routes.ts).
  for (const [name, kind, device] of [["Truck 7", "truck", "sim-truck-1"], ["Bus 3", "bus", "sim-bus-1"], ["Truck 12", "truck", "sim-truck-2"]]) {
    const v = (await q("INSERT INTO vehicles (org_id, name, kind) VALUES ($1, $2, $3) RETURNING id", [org, name, kind])).rows[0].id;
    await q("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1, $2, 'traccar', $3)", [org, v, device]);
  }
  console.log("created demo organization");
}

const hasRoute = (
  await q(
    `SELECT 1 FROM routes r JOIN organizations o ON o.id = r.org_id
     WHERE r.org_id = $1 AND r.route_date = (now() AT TIME ZONE o.timezone)::date`, [org])
).rowCount;
if (!hasRoute) {
  const driver = (await q("SELECT id FROM users WHERE org_id = $1 AND email = 'driver@demo.ca'", [org])).rows[0]?.id;
  const truck = (await q("SELECT id FROM vehicles WHERE org_id = $1 AND name = 'Truck 7'", [org])).rows[0]?.id;
  const route = (
    await q(
      `INSERT INTO routes (org_id, name, route_date, vehicle_id, driver_id)
       SELECT $1, 'Downtown deliveries', (now() AT TIME ZONE timezone)::date, $2, $3 FROM organizations WHERE id = $1 RETURNING id`,
      [org, truck, driver])
  ).rows[0].id;
  const stops: [string, string, number, number][] = [
    ["Queen & Yonge", "1 Queen St W, Toronto", 43.6532, -79.3832],
    ["College & Bathurst", "College St & Bathurst St, Toronto", 43.6629, -79.3957],
    ["Dupont & Dufferin", "Dupont St & Dufferin St, Toronto", 43.6677, -79.4046],
    ["King & Dufferin", "King St W & Dufferin St, Toronto", 43.6455, -79.402],
  ];
  for (const [i, [name, address, lat, lng]] of stops.entries()) {
    await q("INSERT INTO stops (org_id, route_id, sequence, name, address, lat, lng, packages) VALUES ($1, $2, $3, $4, $5, $6, $7, 3)", [org, route, i + 1, name, address, lat, lng]);
  }
  console.log("created today's demo route");
}

if (process.env.SEED_HISTORY !== "0") {
  const h = await seedHistory(pool, org);
  if (h.positions) console.log(`created ${h.positions.toLocaleString("en-CA")} demo positions and ${h.events} tracker alarms (14 days)`);
}

console.log(`
Demo logins (password: ${demoPassword})
  owner@demo.ca       live map, routes, reports
  dispatcher@demo.ca  plans routes and dispatches
  manager@demo.ca     reports, alerts and the audit log
  viewer@demo.ca      read-only
  driver@demo.ca      driver app at /driver`);
await pool.end();
