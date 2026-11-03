import { DynamicModule, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { pg } from "@routenorth/db";
import { AuditController } from "./audit/audit.controller.js";
import { AuditInterceptor } from "./audit/audit.interceptor.js";
import { AuditService } from "./audit/audit.service.js";
import { MeController } from "./me/me.controller.js";
import { OrgController } from "./org/org.controller.js";
import { RolesController } from "./roles/roles.controller.js";
import { SearchController } from "./search/search.controller.js";
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
      controllers: [AuthController, VehiclesController, HistoryController, RoutesController, DriverController, ProofsController, UsersController, MeController, OrgController, RolesController, SearchController, AuditController],
      providers: [
        { provide: PG_POOL, useValue: opts.pool },
        { provide: POSITION_BUS, useValue: opts.bus },
        { provide: JWT_SECRET, useValue: opts.jwtSecret },
        AuthGuard,
        AuditService,
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
        LiveGateway,
      ],
    };
  }
}
