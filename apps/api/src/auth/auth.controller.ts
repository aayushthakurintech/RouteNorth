import { BadRequestException, Body, Controller, HttpCode, Inject, Post, UnauthorizedException } from "@nestjs/common";
import { pg } from "@routenorth/db";
import { DUMMY_HASH, verifyPassword } from "../passwords.js";
import { JWT_SECRET, PG_POOL } from "../tokens.js";
import { signSession } from "./jwt.js";

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(JWT_SECRET) private readonly secret: string,
  ) {}

  @Post("login")
  @HttpCode(200)
  async login(@Body() body: { email?: unknown; password?: unknown }) {
    if (typeof body?.email !== "string" || typeof body?.password !== "string") {
      throw new BadRequestException("email and password are required");
    }
    const found = await this.pool.query<{
      user_id: string; org_id: string; password_hash: string; role: string; locale: string;
    }>("SELECT * FROM find_login($1)", [body.email]);
    const user = found.rows[0];
    const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedException("invalid credentials");

    const token = await signSession(this.secret, { userId: user.user_id, orgId: user.org_id, role: user.role });
    return { token, user: { id: user.user_id, orgId: user.org_id, role: user.role, locale: user.locale } };
  }
}
