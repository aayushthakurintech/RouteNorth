import { CallHandler, ExecutionContext, HttpException, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { catchError, tap, throwError, type Observable } from "rxjs";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { AuditService, summarizeBody } from "./audit.service.js";

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const VERB: Record<string, string> = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Writes that are noise, not changes anyone needs to audit. */
const SKIP = [/^\/me\/prefs/, /^\/driver\/location/, /^\/ops\/usage/];

/** Turns "POST /routes/<id>/stops" into { action: "routes.stops.create", entity: "routes", entityId: "<id>" }. */
export function describeRequest(method: string, rawUrl: string): { action: string; entity: string; entityId: string | null } {
  const path = rawUrl.split("?")[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  const names = parts.filter((p) => !UUID.test(p));
  const entityId = parts.find((p) => UUID.test(p)) ?? null;
  const verb = VERB[method] ?? method.toLowerCase();
  // PUT /driver/stops/:id/proofs/:clientId is an upload: "create" reads better than "update".
  const last = names[names.length - 1] ?? "";
  const action = names.length > 1 && ["PUT", "POST"].includes(method) && /^(status|archive|restore|send|run|complete|reorder|import|assign|reassign|merge|split|approve|reject|revoke|rotate|test)$/.test(last)
    ? names.join(".")
    : `${names.join(".")}.${verb}`;
  return { action, entity: names[0] ?? "", entityId };
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http") return next.handle();
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const method = req.method ?? "GET";
    const url = req.originalUrl ?? req.url ?? "";
    if (!WRITES.has(method) || SKIP.some((r) => r.test(url))) return next.handle();

    const write = (status: number) => {
      const session = req.session;
      if (!session) return; // unauthenticated calls (login) are logged by their own handler
      if (req.auditDone && status < 400) return; // the handler wrote a fuller row (old and new values) in the same transaction
      const d = describeRequest(method, url);
      void this.audit.record({
        orgId: session.orgId, actorId: session.userId, actorLabel: req.actor?.email ?? null,
        action: d.action, entity: d.entity, entityId: d.entityId, method, path: url.split("?")[0], status,
        detail: summarizeBody(req.body), ip: req.ip ?? null,
      });
    };
    return next.handle().pipe(
      tap(() => {
        const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
        write(res.statusCode);
      }),
      catchError((err) => {
        write(err instanceof HttpException ? err.getStatus() : 500);
        return throwError(() => err);
      }),
    );
  }
}
