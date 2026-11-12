import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import { encryptSecret, pg, withOrg } from "@routenorth/db";
import { checkProvider, cleanProviderSettings, ConnectorError, PROVIDERS, type FetchLike, type ProviderKind } from "@routenorth/shared";
import { AuthGuard, requireAny, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { JWT_SECRET, PG_POOL } from "../tokens.js";

const COLUMNS = `id, provider, name, settings, status, last_sync_at AS "lastSyncAt", last_data_at AS "lastDataAt", last_error AS "lastError", created_at AS "createdAt"`;

/**
 * Sign in to a company's own GPS provider account (Geotab, Samsara) so the ingest service can pull positions from it.
 * The password or token is checked with the provider, then stored encrypted; it is never sent back.
 */
@Controller("portal/provider-connections")
@UseGuards(AuthGuard)
export class PortalProviderConnectionsController {
  /** Replaced in tests; the real provider is called otherwise. */
  static fetchFn: FetchLike = (url, init) => fetch(url, init);

  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(JWT_SECRET) private readonly secret: string) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "integrations.manage", "api.manage", "fleet.manage");
    const rows = await withOrg(this.pool, orgId, async (c) => (await c.query(`SELECT ${COLUMNS} FROM provider_connections ORDER BY created_at`)).rows);
    return { connections: rows, polling: !!(process.env.JWT_SECRET || process.env.ENCRYPTION_KEY) };
  }

  /** `secret` is the Geotab password or the Samsara API token. Saved only when the provider accepts it. */
  @Post()
  async create(@Req() req: AuthedRequest, @Body() b: { provider?: unknown; name?: unknown; settings?: unknown; secret?: unknown }) {
    const orgId = requireAny(req, "integrations.manage", "api.manage");
    const provider = String(b?.provider ?? "") as ProviderKind;
    if (!PROVIDERS.includes(provider)) throw new BadRequestException(`provider must be one of ${PROVIDERS.join(", ")}`);
    const settings = cleanProviderSettings(provider, (b?.settings && typeof b.settings === "object" ? b.settings : {}) as Record<string, unknown>);
    if (typeof settings === "string") throw new BadRequestException(settings);
    const secret = typeof b?.secret === "string" ? b.secret.trim() : "";
    if (!secret || secret.length > 500) throw new BadRequestException(provider === "geotab" ? "password is required" : "API token is required");
    const name = (typeof b?.name === "string" && b.name.trim() ? b.name.trim() : provider === "geotab" ? "Geotab" : "Samsara").slice(0, 80);

    try {
      await checkProvider({ provider, settings, secret }, PortalProviderConnectionsController.fetchFn);
    } catch (e) {
      throw new BadRequestException(e instanceof ConnectorError ? e.message : "could not check the login with the provider");
    }
    return withOrg(this.pool, orgId, async (c) => {
      const n = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM provider_connections")).rows[0]!.n;
      if (n >= 10) throw new BadRequestException("at most 10 provider accounts; remove one first");
      return (await c.query(
        `INSERT INTO provider_connections (org_id, provider, name, settings, secret_enc, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLUMNS}`,
        [orgId, provider, name, settings, encryptSecret(this.secret, secret), req.session!.userId])).rows[0];
    });
  }

  @Post(":id/pause")
  @HttpCode(200)
  pause(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.setStatus(req, id, "UPDATE provider_connections SET status = 'paused' WHERE id = $1");
  }

  /** Try again now: clears the failure count, so a fixed problem does not wait out the back-off. */
  @Post(":id/resume")
  @HttpCode(200)
  resume(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.setStatus(req, id, "UPDATE provider_connections SET status = 'pending', failures = 0, next_run_at = now() WHERE id = $1");
  }

  /** Removes the saved login. Devices and positions already pulled stay. */
  @Delete(":id")
  @HttpCode(200)
  remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.setStatus(req, id, "DELETE FROM provider_connections WHERE id = $1");
  }

  private async setStatus(req: AuthedRequest, id: string, sql: string) {
    const orgId = requireAny(req, "integrations.manage", "api.manage");
    const r = await withOrg(this.pool, orgId, (c) => c.query(sql, [parseUuid(id)]));
    if (!r.rowCount) throw new NotFoundException("connection not found");
    return { ok: true };
  }
}
