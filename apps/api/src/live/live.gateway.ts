import { Inject } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { verifySession } from "../auth/jwt.js";
import { JWT_SECRET, POSITION_BUS } from "../tokens.js";
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
  ) {}

  async handleConnection(client: WebSocket, req: IncomingMessage): Promise<void> {
    const token = new URL(req.url ?? "", "http://localhost").searchParams.get("token");
    const session = token ? await verifySession(this.secret, token) : null;
    if (!session) {
      client.close(4401, "unauthorized");
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
