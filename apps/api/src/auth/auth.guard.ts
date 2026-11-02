import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JWT_SECRET } from "../tokens.js";
import { verifySession, type Session } from "./jwt.js";

export interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  session?: Session;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(JWT_SECRET) private readonly secret: string) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
    const session = token ? await verifySession(this.secret, token) : null;
    if (!session) throw new UnauthorizedException();
    req.session = session;
    return true;
  }
}
