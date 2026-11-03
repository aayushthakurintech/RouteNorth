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
import { ResourcesController } from "./resources/resources.controller.js";
import { RoutesController } from "./routes/routes.controller.js";
import { PlanController } from "./plan/plan.controller.js";
import type { RoutingProvider } from "./plan/providers.js";
import { DispatchController } from "./dispatch/dispatch.controller.js";
import { AttachmentsController, RoutePlanningController } from "./dispatch/dispatch.controller.js";
import { GeocodeController } from "./dispatch/geocode.controller.js";
import type { Geocoder } from "./dispatch/geocoder.js";
import { FleetController } from "./fleet/fleet.controller.js";
import { LiveExtrasController, PublicFeedbackController, PublicTrackController, ShareController } from "./fleet/live-extras.controller.js";
import type { WeatherProvider } from "./weather/provider.js";
import type { Providers } from "./notify/notifier.js";
import { NOTIFY, GEOCODER, WEATHER, JWT_SECRET, PG_POOL, POSITION_BUS, ROUTING_PROVIDER } from "./tokens.js";
import { AnalyticsController } from "./analytics/analytics.controller.js";
import { AlertsController } from "./alerts/alerts.controller.js";
import { PublicReportController, ReportsController } from "./reports/reports.controller.js";
import { AnalyticsService } from "./analytics/analytics.service.js";
import { ApprovalsController, AutomationController, WebhooksController } from "./automation/automation.controller.js";
import { PublicJobController } from "./customer/public.controller.js";
import { DriverExtrasController } from "./driver/driver-extras.controller.js";
import { ExpensesController, HelpRequestsController, MessagesController, TimesheetsController } from "./driver/office.controller.js";
import { InvoicesController, MessageDefaultsController, PortalController } from "./customer/portal.controller.js";
import { VehiclesController } from "./vehicles/vehicles.controller.js";

export interface AppOptions {
  pool: pg.Pool;
  bus: PositionBus;
  jwtSecret: string;
  /** Real road travel times (OSRM or Valhalla). Without one, plans use estimates. */
  routing?: RoutingProvider | null;
  /** Address search (Nominatim-compatible). Without one, only saved addresses are suggested. */
  geocoder?: Geocoder | null;
  /** Forecasts (Open-Meteo by default). */
  weather?: WeatherProvider | null;
  /** Where alerts and scheduled reports are sent (Slack, Teams, email, SMS). */
  notify?: Providers | null;
}

@Module({})
export class AppModule {
  static register(opts: AppOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [AuthController, VehiclesController, HistoryController, RoutesController, DriverController, ProofsController, UsersController, MeController, OrgController, RolesController, SearchController, AuditController, ResourcesController, PlanController, DispatchController, GeocodeController, AttachmentsController, RoutePlanningController, FleetController, ShareController, PublicTrackController, LiveExtrasController, AnalyticsController, ReportsController, PublicReportController, AlertsController, PublicFeedbackController, AutomationController, WebhooksController, ApprovalsController, PublicJobController, DriverExtrasController, MessagesController, HelpRequestsController, TimesheetsController, ExpensesController, PortalController, InvoicesController, MessageDefaultsController],
      providers: [
        { provide: PG_POOL, useValue: opts.pool },
        { provide: POSITION_BUS, useValue: opts.bus },
        { provide: JWT_SECRET, useValue: opts.jwtSecret },
        { provide: ROUTING_PROVIDER, useValue: opts.routing ?? null },
        { provide: GEOCODER, useValue: opts.geocoder ?? null },
        { provide: WEATHER, useValue: opts.weather ?? null },
        { provide: NOTIFY, useValue: opts.notify ?? { fetch } },
        AuthGuard,
        AnalyticsService,
        AuditService,
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
        LiveGateway,
      ],
    };
  }
}
