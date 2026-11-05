"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { AuthShell } from "@/components/auth/AuthShell";
import { PasswordField } from "@/components/auth/PasswordField";
import { useI18n } from "@/lib/i18n-context";
import { API_URL, saveSession } from "@/lib/session";

type LoginError = "loginFailed" | "loginUnreachable" | "loginServerError" | "mfa_wrong" | "mfa_locked" | "mfa_expired" | "au_rate";

function LoginForm() {
  const { t, setLocale } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<LoginError | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const justReset = params.get("reset") === "1";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const second = challenge !== null;
      const res = await fetch(`${API_URL}${second ? "/auth/mfa" : "/auth/login"}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(second ? { challenge, code } : { email: email.trim(), password }),
      });
      if (!res.ok) {
        // Only a 401 means the credentials were wrong; anything else is a server problem.
        if (res.status === 429) setError(second ? "mfa_locked" : "au_rate");
        else if (second) setError(res.status === 401 ? "mfa_wrong" : "loginServerError");
        else setError(res.status === 401 ? "loginFailed" : "loginServerError");
        if (second && res.status === 401 && (await res.clone().json().catch(() => null))?.message?.includes("expired")) { setError("mfa_expired"); setChallenge(null); setCode(""); }
        return;
      }
      const body = await res.json();
      if (body.mfaRequired) { setChallenge(body.challenge); setCode(""); return; }
      const { token, user } = body;
      saveSession({ token, locale: user.locale, role: user.role });
      setLocale(user.locale);
      router.replace(user.home ?? (user.role === "driver" ? "/driver" : "/"));
    } catch {
      // fetch itself failed: API not running, wrong address, or blocked by CORS.
      setError("loginUnreachable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={t("signIn")} subtitle={t("au_signin_sub")}
      footer={<>{t("au_new")} <Link href="/signup">{t("au_create")}</Link></>}
    >
      <form onSubmit={onSubmit} noValidate={false}>
        {justReset && !error && <p role="status" className="notice">{t("au_reset_done")}</p>}
        {challenge !== null ? (
          <div>
            <p className="auth-sub" style={{ margin: "0 0 12px" }}>{t("mfa_hint")}</p>
            <label htmlFor="mfa-code">{t("mfa_code")}</label>
            <input id="mfa-code" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={error === "mfa_wrong" || undefined} />
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="login-email">{t("email")}</label>
              <input id="login-email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={error === "loginFailed" || undefined} />
            </div>
            <PasswordField label={t("password")} value={password} onChange={setPassword} autoComplete="current-password" id="login-password" invalid={error === "loginFailed"} />
            <div className="auth-row"><span /><Link href="/forgot">{t("au_forgot")}</Link></div>
          </>
        )}
        {error && <p role="alert" className="error">{t(error)}</p>}
        <button type="submit" disabled={busy}>{challenge !== null ? t("mfa_verify") : t("signIn")}</button>
        {challenge !== null && <button type="button" className="link" onClick={() => { setChallenge(null); setCode(""); setError(null); }}>{t("mfa_back")}</button>}
      </form>
    </AuthShell>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
