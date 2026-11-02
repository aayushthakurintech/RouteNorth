import { Controller, Get, Inject, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { vehicleStatus, type VehicleStatus } from "@routenorth/shared";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard.js";
import { PG_POOL } from "../tokens.js";

export interface LiveVehicle {
  deviceId: string;
  vehicleId: string | null;
  name: string;
  kind: string;
  time: string;
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  ignition: boolean | null;
  status: VehicleStatus;
}

@Controller("vehicles")
@UseGuards(AuthGuard)
export class VehiclesController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Every vehicle in the organization, for pickers (not just those with a position). */
  @Get()
  async list(@Req() req: AuthedRequest): Promise<{ id: string; name: string; kind: string }[]> {
    const rows = await withOrg(this.pool, req.session!.orgId, (c) => c.query("SELECT id, name, kind FROM vehicles ORDER BY name"));
    return rows.rows;
  }

  /** Latest known position of every device in the caller's organization. */
  @Get("live")
  async live(@Req() req: AuthedRequest): Promise<LiveVehicle[]> {
    const orgId = req.session!.orgId;
    const rows = await withOrg(this.pool, orgId, (c) =>
      c.query(
        `SELECT d.id AS device_id, v.id AS vehicle_id, coalesce(v.name, d.external_id) AS name,
                coalesce(v.kind, 'car') AS kind, lp.time, lp.lat, lp.lng, lp.speed, lp.heading, lp.ignition
         FROM latest_positions lp
         JOIN devices d ON d.id = lp.device_id
         LEFT JOIN vehicles v ON v.id = d.vehicle_id
         ORDER BY name`,
      ),
    );
    return rows.rows.map((r) => {
      const time = new Date(r.time).toISOString();
      return {
        deviceId: r.device_id, vehicleId: r.vehicle_id, name: r.name, kind: r.kind, time,
        lat: r.lat, lng: r.lng, speed: r.speed, heading: r.heading, ignition: r.ignition,
        status: vehicleStatus({ time, speed: r.speed, ignition: r.ignition }),
      };
    });
  }
}
