import { DynamicModule, Module } from "@nestjs/common";
import { pg } from "@routenorth/db";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { DriverController, ProofsController } from "./driver/driver.controller.js";
import { UsersController } from "./users/users.controller.js";
import { HistoryController } from "./history/history.controller.js";
import { LiveGateway } from "./live/live.gateway.js";
import type { PositionBus } from "./live/position-bus.js";
import { RoutesController } from "./routes/routes.controller.js";
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
      controllers: [AuthController, VehiclesController, HistoryController, RoutesController, DriverController, ProofsController, UsersController],
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
