import { Inject } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { pg, withOrg } from "@routenorth/db";
import { effectivePermissions, hasSection, resolveEntitlements } from "@routenorth/shared";
import { verifySession } from "../auth/jwt.js";
import { JWT_SECRET, PG_POOL, POSITION_BUS } from "../tokens.js";
import type { PositionBus } from "./position-bus.js";

/**
 * Live position stream: connect to /live?token=<jwt>. The server only ever subscribes the
 * socket to the organization named in the verified token, never to a client-supplied one.
 */
@WebSocketGateway({ path: "/live" })
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly cleanups = new Map<WebSocket, () => Promise<void>>();

  constructor(
    @Inject(JWT_SECRET) private readonly secret: string,
    @Inject(POSITION_BUS) private readonly bus: PositionBus,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  async handleConnection(client: WebSocket, req: IncomingMessage): Promise<void> {
    const token = new URL(req.url ?? "", "http://localhost").searchParams.get("token");
    const session = token ? await verifySession(this.secret, token) : null;
    if (!session) {
      client.close(4401, "unauthorized");
      return;
    }
    // Only people who may see the fleet get the live stream (not drivers or customers).
    const user = (
      await withOrg(this.pool, session.orgId, (c) =>
        c.query<{ role: string; custom: string[] | null; disabled: boolean; org_status: string; sections: string[] | null; limits: unknown }>(
          `SELECT u.role, cr.permissions AS custom, (u.disabled_at IS NOT NULL) AS disabled,
                  (SELECT o.status FROM organizations o WHERE o.id = u.org_id) AS org_status,
                  (SELECT e.sections FROM org_entitlements e WHERE e.org_id = u.org_id) AS sections,
                  (SELECT e.limits FROM org_entitlements e WHERE e.org_id = u.org_id) AS limits
           FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id AND cr.org_id = u.org_id WHERE u.id = $1`,
          [session.userId]),
      )
    ).rows[0];
    // The live stream is part of the tracking section, and is closed for a suspended company. Staff "view as" tokens are not accepted here.
    const ent = resolveEntitlements(user?.sections ? { sections: user.sections, limits: user.limits } : null);
    if (!user || user.disabled || session.imp || user.org_status === "suspended" || !hasSection(ent, "tracking") || !effectivePermissions(user.role, user.custom).has("fleet.view")) {
      client.close(4403, "forbidden");
      return;
    }
    const unsubscribe = await this.bus.subscribe(session.orgId, (json) => {
      if (client.readyState === client.OPEN) client.send(json);
    });
    if (client.readyState !== client.OPEN) {
      await unsubscribe();
      return;
    }
    this.cleanups.set(client, unsubscribe);
  }

  async handleDisconnect(client: WebSocket): Promise<void> {
    const cleanup = this.cleanups.get(client);
    this.cleanups.delete(client);
    await cleanup?.();
  }
}
