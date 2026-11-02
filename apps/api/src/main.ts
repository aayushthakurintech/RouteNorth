import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { pg } from "@routenorth/db";
import { AppModule } from "./app.module.js";
import { configureApp } from "./configure.js";
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
  }),
);
configureApp(app);
app.enableCors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" });
await app.listen(Number(process.env.PORT ?? 4000));
