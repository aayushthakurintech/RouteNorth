import { ArgumentsHost, Catch, HttpException, Inject } from "@nestjs/common";
import { BaseExceptionFilter, HttpAdapterHost } from "@nestjs/core";
import { pg, withOrg } from "@routenorth/db";
import { PG_POOL } from "../tokens.js";

/** Keeps a short record of server errors (5xx) for the health page. No request bodies or query strings are stored. */
@Catch()
export class ErrorLogFilter extends BaseExceptionFilter {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(HttpAdapterHost) host: HttpAdapterHost) { super(host.httpAdapter); }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500) {
      const req = host.switchToHttp().getRequest<{ session?: { orgId: string }; method?: string; originalUrl?: string; url?: string }>();
      const path = (req.originalUrl ?? req.url ?? "").replace(/\?.*$/, "").slice(0, 300);
      const message = (exception instanceof Error ? exception.message : String(exception)).slice(0, 500);
      if (req.session?.orgId) {
        void withOrg(this.pool, req.session.orgId, (c) => c.query("INSERT INTO error_log (org_id, status, method, path, message) VALUES ($1,$2,$3,$4,$5)", [req.session!.orgId, status, req.method ?? null, path, message])).catch((e) => console.error("error log", e.message));
      }
    }
    super.catch(exception, host);
  }
}
