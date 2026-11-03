import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { pg } from "@routenorth/db";
import { AppModule } from "./app.module.js";
import { configureApp } from "./configure.js";
import { runScheduledTasks } from "./dispatch/scheduler.js";
import { geocoderFromEnv } from "./dispatch/geocoder.js";
import { providerFromEnv } from "./plan/providers.js";
import { MemoryPositionBus, RedisPositionBus } from "./live/position-bus.js";

const databaseUrl = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;
if (!databaseUrl) throw new Error("DATABASE_URL (or APP_DATABASE_URL) is required");
if (!jwtSecret || jwtSecret.length < 32) throw new Error("JWT_SECRET (32+ characters) is required");

const app = await NestFactory.create(
  AppModule.register({
    pool: new pg.Pool({ connectionString: databaseUrl }),
    bus: process.env.REDIS_URL ? new RedisPositionBus(process.env.REDIS_URL) : new MemoryPositionBus(),
    jwtSecret,
    routing: providerFromEnv(),
    geocoder: geocoderFromEnv(),
  }),
);
configureApp(app);
// localhost and 127.0.0.1 are different origins to a browser, so allow both by default.
app.enableCors({ origin: process.env.WEB_ORIGIN?.split(",") ?? ["http://localhost:3000", "http://127.0.0.1:3000"] });
await app.listen(Number(process.env.PORT ?? 4000));
// Repeating routes: check on start and every 15 minutes.
const schedulerPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const tick = () => void runScheduledTasks(schedulerPool, (m) => console.log(m)).catch((e) => console.error("scheduler", e));
tick();
setInterval(tick, 15 * 60_000).unref();
