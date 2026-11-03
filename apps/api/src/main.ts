import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { pg } from "@routenorth/db";
import { AppModule } from "./app.module.js";
import { configureApp } from "./configure.js";
import { runScheduledTasks } from "./dispatch/scheduler.js";
import { geocoderFromEnv } from "./dispatch/geocoder.js";
import { weatherFromEnv } from "./weather/provider.js";
import { providerFromEnv } from "./plan/providers.js";
import { AnalyticsService } from "./analytics/analytics.service.js";
import { runAlertTick } from "./alerts/engine.js";
import { providersFromEnv } from "./notify/notifier.js";
import { runDueReports } from "./reports/scheduler.js";
import { BadRequestException } from "@nestjs/common";
import { runAutomation } from "./automation/processor.js";
import { PlanController } from "./plan/plan.controller.js";
import { MemoryPositionBus, RedisPositionBus } from "./live/position-bus.js";
import { runRetention } from "./ops/retention.js";

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
    weather: weatherFromEnv(),
    notify: providersFromEnv(),
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
// Data retention: remove what each organization chose not to keep, once a day.
const retention = () => void runRetention(schedulerPool, (m) => console.log(m)).catch((e) => console.error("retention", e));
setTimeout(retention, 90_000).unref();
setInterval(retention, 24 * 3_600_000).unref();
// Alerts: check the rules every minute. Scheduled reports go out when their hour comes (checked every minute too).
const notify = providersFromEnv();
const analytics = app.get(AnalyticsService);
const planner = app.get(PlanController);
const automation = {
  providers: notify, secret: jwtSecret,
  // "No pending stops" just means there is nothing left to re-plan.
  replan: async (c: pg.PoolClient, orgId: string, routeId: string) => { try { return await planner.reoptimize(c, orgId, routeId, null, { apply: true }); } catch (e) { if (e instanceof BadRequestException) return null; throw e; } },
};
let busy = false;
const minute = () => {
  if (busy) return; // a slow pass must not overlap the next one
  busy = true;
  void (async () => {
    await runAutomation(schedulerPool, automation, (m) => console.log(m)).catch((e) => console.error("automation", e));
    await runAlertTick(schedulerPool, analytics, notify, (m) => console.log(m)).catch((e) => console.error("alerts", e));
    await runDueReports(schedulerPool, analytics, notify, (m) => console.log(m)).catch((e) => console.error("report schedules", e));
  })().finally(() => { busy = false; });
};
setTimeout(minute, 20_000).unref();
setInterval(minute, 60_000).unref();
