/**
 * Password rules shared by sign-up, reset and the invite page, so the screen and the server agree.
 * Follows current guidance (NIST SP 800-63B): length matters most, no forced symbol mixes, and the worst
 * common passwords and obvious personal details are refused. Passwords are never logged or stored in the clear.
 */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** A short list of the passwords attackers try first. It is a floor, not a breach database. */
const COMMON = new Set([
  "password", "password1", "password12", "password123", "password1234", "passw0rd123", "qwertyuiop", "qwerty12345", "qwertyuiop123",
  "1234567890", "12345678910", "123456789012", "0123456789", "1q2w3e4r5t", "1qaz2wsx3edc", "iloveyou123", "letmein1234", "welcome1234",
  "admin12345", "administrator", "changeme123", "trustno1234", "abc1234567", "monkey12345", "dragon12345", "football123", "baseball123",
  "routenorth", "routenorth1", "routenorth123", "fleetmanager", "truckdriver1", "canada12345", "toronto12345",
]);

export type PasswordProblem = "short" | "long" | "common" | "repeated" | "personal";

export interface PasswordContext { email?: string; name?: string; company?: string }

export function passwordProblem(pw: string, ctx: PasswordContext = {}): PasswordProblem | null {
  if (pw.length < PASSWORD_MIN) return "short";
  if (pw.length > PASSWORD_MAX) return "long";
  const flat = pw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (COMMON.has(pw.toLowerCase()) || COMMON.has(flat)) return "common";
  if (/^(.)\1+$/.test(pw) || /^(.{1,3})\1{3,}$/.test(pw)) return "repeated";
  const personal = [ctx.email?.split("@")[0], ...(ctx.name ?? "").split(/\s+/), ...(ctx.company ?? "").split(/\s+/)]
    .map((s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((s) => s.length >= 4);
  if (personal.some((p) => flat.includes(p))) return "personal";
  return null;
}

/** 0 (refused or empty) to 4 (strong), for the meter next to the field. Length first, variety second. */
export function passwordStrength(pw: string, ctx: PasswordContext = {}): 0 | 1 | 2 | 3 | 4 {
  if (!pw || passwordProblem(pw, ctx)) return pw.length >= PASSWORD_MIN && passwordProblem(pw, ctx) !== "short" ? 1 : 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const unique = new Set(pw).size;
  const score = (pw.length >= 16 ? 2 : pw.length >= 12 ? 1 : 0) + (classes >= 3 ? 1 : 0) + (unique >= 10 ? 1 : 0);
  return Math.max(2, Math.min(4, 1 + score)) as 2 | 3 | 4;
}
