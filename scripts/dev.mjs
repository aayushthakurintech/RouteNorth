// Starts the API, ingest service and web app for local development, and (with --simulate)
// the vehicle simulator. Stop everything with Ctrl-C. Works the same on macOS, Linux and Windows.
//
// Needs Postgres and Redis running first (pnpm infra:up) and the demo data (pnpm seed).
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const simulate = process.argv.includes("--simulate");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const shell = process.platform === "win32";

const env = {
  APP_DATABASE_URL: "postgres://routenorth_app:routenorth_app@localhost:5432/routenorth",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "local-dev-secret-change-me-local-dev-secret",
  ...process.env,
};

console.log("building…");
const build = spawnSync(pnpm, ["build"], { cwd: root, stdio: "inherit", shell });
if (build.status !== 0) process.exit(build.status ?? 1);

const children = [];
const run = (name, cmd, args, extra = {}) => {
  const child = spawn(cmd, args, { cwd: root, env: { ...env, ...extra }, stdio: "inherit", shell });
  child.on("exit", (code) => { if (code) console.error(`${name} exited with code ${code}`); });
  children.push(child);
};

run("api", process.execPath, ["apps/api/dist/main.js"], { PORT: "4000" });
run("ingest", process.execPath, ["apps/ingest/dist/server.js"], { PORT: "4100" });
run("web", pnpm, ["--filter", "@routenorth/web", "dev"]);
// Straight into ingest, so Traccar is not required for the demo.
if (simulate) run("simulator", pnpm, ["--filter", "@routenorth/simulator", "start"], { INGEST_URL: "http://localhost:4100" });

console.log("\nWeb app:  http://localhost:3000   (driver app: http://localhost:3000/driver)\nAPI:      http://localhost:4000\n");

const stop = () => { children.forEach((c) => c.kill()); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
