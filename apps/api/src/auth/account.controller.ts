import { BadRequestException, Body, ConflictException, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { pg } from "@routenorth/db";
import { effectivePermissions, homePath, LOCALES, passwordProblem } from "@routenorth/shared";
import { createHash, randomBytes } from "node:crypto";
import { AuditService } from "../audit/audit.service.js";
import { limit } from "../customer/public.controller.js";
import { deliver, type Providers } from "../notify/notifier.js";
import { hashPassword } from "../passwords.js";
import { startSession } from "../security/sessions.js";
import { withDefaults } from "../org/settings.js";
import { JWT_SECRET, NOTIFY, PG_POOL } from "../tokens.js";
import type { AuthedRequest } from "./auth.guard.js";

/** Which version of the terms and privacy notice a person agreed to. Bump it whenever those pages change in substance. */
export const TERMS_VERSION = "2026-11";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const str = (v: unknown, name: string, min: number, max: number): string => {
  if (typeof v !== "string") throw new BadRequestException(`${name} is required`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new BadRequestException(`${name} must be ${min} to ${max} characters`);
  return s;
};
const PROBLEM_TEXT = {
  short: "use at least 10 characters", long: "use at most 200 characters", common: "that password is too common, choose another",
  repeated: "avoid repeated characters", personal: "do not use your name, email or company in the password",
} as const;

/**
 * Self-service accounts: create a company (its first owner), and reset a forgotten password by emailed link.
 * Every route is public, so every one is rate limited, and none says whether an email is known except sign-up (which must).
 */
@Controller("auth")
export class AccountController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(JWT_SECRET) private readonly secret: string,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NOTIFY) private readonly notify: Providers,
  ) {}

  @Post("signup")
  @HttpCode(201)
  async signup(@Req() req: AuthedRequest, @Body() b: { company?: unknown; name?: unknown; email?: unknown; password?: unknown; locale?: unknown; acceptTerms?: unknown; marketing?: unknown }) {
    limit(`signup:${req.ip ?? "?"}`, 6, 3_600_000);
    const company = str(b?.company, "company", 2, 100);
    const name = str(b?.name, "name", 1, 80);
    const email = str(b?.email, "email", 3, 200).toLowerCase();
    if (!EMAIL.test(email)) throw new BadRequestException("a valid email is required");
    if (typeof b.password !== "string") throw new BadRequestException("password is required");
    const bad = passwordProblem(b.password, { email, name, company });
    if (bad) throw new BadRequestException(PROBLEM_TEXT[bad]);
    if (b.acceptTerms !== true) throw new BadRequestException("you need to accept the terms and privacy notice");
    const locale = (LOCALES as readonly unknown[]).includes(b.locale) ? (b.locale as string) : "en";
    const hash = await hashPassword(b.password);
    let row: { org_id: string; user_id: string } | undefined;
    try {
      row = (await this.pool.query<{ org_id: string; user_id: string }>(
        "SELECT * FROM signup_organization($1,$2,$3,$4,$5,$6,$7,$8)", [company, email, hash, name, locale, TERMS_VERSION, b.marketing === true, req.ip ?? null])).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ConflictException("that email already has an account, sign in instead");
      throw e;
    }
    if (!row) throw new Error("sign-up did not create an account");
    await this.audit.record({ orgId: row.org_id, actorId: row.user_id, actorLabel: email, action: "auth.signup", entity: "organization", entityId: row.org_id, method: "POST", path: "/auth/signup", status: 201, ip: req.ip ?? null });
    const hours = withDefaults({}).sessionHours;
    const token = await startSession(this.pool, this.secret, { userId: row.user_id, orgId: row.org_id, role: "owner" }, hours, req);
    return { token, user: { id: row.user_id, orgId: row.org_id, role: "owner", locale, home: homePath("owner", effectivePermissions("owner")) } };
  }

  /** Always answers the same way, so it cannot be used to find out who has an account. */
  @Post("forgot")
  @HttpCode(202)
  async forgot(@Req() req: AuthedRequest, @Body() b: { email?: unknown }) {
    limit(`forgot:${req.ip ?? "?"}`, 8, 15 * 60_000);
    const email = typeof b?.email === "string" ? b.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || email.length > 200) throw new BadRequestException("a valid email is required");
    limit(`forgot:mail:${email}`, 3, 3_600_000);
    const token = randomBytes(32).toString("base64url");
    const row = (await this.pool.query<{ user_id: string; org_id: string; email: string; locale: string }>(
      "SELECT * FROM start_password_reset($1,$2, now() + interval '60 minutes')", [email, sha(token)])).rows[0];
    if (row) {
      const base = (process.env.APP_URL ?? process.env.WEB_ORIGIN?.split(",")[0] ?? "http://localhost:3000").replace(/\/$/, "");
      const link = `${base}/reset/${token}`;
      await this.audit.record({ orgId: row.org_id, actorId: row.user_id, actorLabel: row.email, action: "auth.password.reset_requested", entity: "auth", method: "POST", path: "/auth/forgot", status: 202, ip: req.ip ?? null });
      const fr = row.locale === "fr";
      const sent = await deliver({ id: row.user_id, kind: "email", target: row.email, label: row.email }, {
        subject: fr ? "Réinitialiser votre mot de passe RouteNorth" : "Reset your RouteNorth password",
        text: fr
          ? `Quelqu'un a demandé la réinitialisation du mot de passe de ce compte. Ouvrez ce lien dans l'heure pour en choisir un nouveau :\n${link}\n\nSi ce n'est pas vous, ignorez ce message : votre mot de passe ne change pas.`
          : `Someone asked to reset the password for this account. Open this link within one hour to choose a new one:\n${link}\n\nIf this was not you, ignore this message and your password stays as it is.`,
        link,
      }, this.notify);
      // Without an email account configured the link goes to the server log, for development only. It is never sent back to the caller.
      if (!sent.ok && sent.unconfigured && process.env.NODE_ENV !== "production") console.log(`[dev] password reset link for ${row.email}: ${link}`);
    }
    return { ok: true };
  }

  @Post("reset")
  @HttpCode(200)
  async reset(@Req() req: AuthedRequest, @Body() b: { token?: unknown; password?: unknown }) {
    limit(`reset:${req.ip ?? "?"}`, 10, 15 * 60_000);
    if (typeof b?.token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(b.token)) throw new BadRequestException("this link is not valid");
    if (typeof b.password !== "string") throw new BadRequestException("password is required");
    const bad = passwordProblem(b.password);
    if (bad) throw new BadRequestException(PROBLEM_TEXT[bad]);
    const row = (await this.pool.query<{ user_id: string; org_id: string; email: string }>("SELECT * FROM finish_password_reset($1,$2)", [sha(b.token), await hashPassword(b.password)])).rows[0];
    if (!row) throw new BadRequestException("this link has expired or was already used, ask for a new one");
    await this.audit.record({ orgId: row.org_id, actorId: row.user_id, actorLabel: row.email, action: "auth.password.reset", entity: "auth", method: "POST", path: "/auth/reset", status: 200, ip: req.ip ?? null });
    return { ok: true };
  }
}
