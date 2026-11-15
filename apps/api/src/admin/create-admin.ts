/**
 * Creates the first super admin (or any staff account) from the command line, because the console cannot create the first one.
 *
 *   JWT_SECRET=... DATABASE_URL=... node dist/admin/create-admin.js --email you@company.ca --name "Your Name" [--role super_admin] [--ip 203.0.113.0/24,198.51.100.7]
 *
 * It prints a temporary password, the authenticator secret and ten recovery codes ONCE. The account must choose a new
 * password at its first sign-in. Run it on a trusted machine; do not paste the output into chat or tickets.
 */
import { pg, withPlatform } from "@routenorth/db";
import { isPlatformRole } from "@routenorth/shared";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../passwords.js";
import { encryptSecret } from "../security/secrets.js";
import { hashRecovery, newRecoveryCodes, newSecret, otpauthUrl } from "../security/totp.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const email = arg("email")?.trim().toLowerCase();
const name = arg("name")?.trim();
const role = arg("role") ?? "super_admin";
const ips = (arg("ip") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const url = process.env.DATABASE_URL;
const secret = process.env.JWT_SECRET;
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !name) throw new Error('usage: --email you@company.ca --name "Your Name" [--role super_admin|account_manager|support|auditor] [--ip a,b]');
if (!isPlatformRole(role)) throw new Error("unknown role");
if (!url) throw new Error("DATABASE_URL is required");
if (!secret || secret.length < 32) throw new Error("JWT_SECRET (32+ characters, the same one the API uses) is required");

const pool = new pg.Pool({ connectionString: url });
try {
  if ((await pool.query("SELECT 1 FROM find_login($1)", [email])).rowCount) throw new Error("that email already belongs to a client account");
  const seed = newSecret();
  const codes = newRecoveryCodes();
  const temp = randomBytes(15).toString("base64url");
  await withPlatform(pool, async (c) => {
    await c.query(
      `INSERT INTO platform_admins (email, display_name, password_hash, role, totp_secret, recovery_hashes, must_change_password, ip_allow_list)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
      [email, name, await hashPassword(temp), role, encryptSecret(secret, seed), codes.map(hashRecovery), ips]);
    await c.query("INSERT INTO platform_audit (action, admin_email, target, detail) VALUES ('admin.created_by_cli',$1,$1,$2)", [email, JSON.stringify({ role })]);
  });
  console.log(`\nStaff account created: ${email} (${role})\n`);
  console.log(`Temporary password : ${temp}`);
  console.log(`Authenticator key  : ${seed}`);
  console.log(`Authenticator URI  : ${otpauthUrl(seed, email, "RouteNorth Admin")}`);
  console.log(`Recovery codes     : ${codes.join("  ")}\n`);
  console.log("Add the key to an authenticator app now. This is the only time these are shown. Sign in at /login, then choose your own password.");
} finally {
  await pool.end();
}
