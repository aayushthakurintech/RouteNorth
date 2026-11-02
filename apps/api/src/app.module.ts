import { DynamicModule, Module } from "@nestjs/common";
import { pg } from "@routenorth/db";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { LiveGateway } from "./live/live.gateway.js";
import type { PositionBus } from "./live/position-bus.js";
import { JWT_SECRET, PG_POOL, POSITION_BUS } from "./tokens.js";
import { VehiclesController } from "./vehicles/vehicles.controller.js";

export interface AppOptions {
  pool: pg.Pool;
  bus: PositionBus;
  jwtSecret: string;
}

@Module({})
export class AppModule {
  static register(opts: AppOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [AuthController, VehiclesController],
      providers: [
        { provide: PG_POOL, useValue: opts.pool },
        { provide: POSITION_BUS, useValue: opts.bus },
        { provide: JWT_SECRET, useValue: opts.jwtSecret },
        AuthGuard,
        LiveGateway,
      ],
    };
  }
}
