"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useI18n } from "@/lib/i18n-context";
import { API_URL, saveSession } from "@/lib/session";

export default function LoginPage() {
  const { t, setLocale } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<"loginFailed" | "loginUnreachable" | "loginServerError" | "mfa_wrong" | "mfa_locked" | "mfa_expired" | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const second = challenge !== null;
      const res = await fetch(`${API_URL}${second ? "/auth/mfa" : "/auth/login"}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(second ? { challenge, code } : { email, password }),
      });
      if (!res.ok) {
        // Only a 401 means the credentials were wrong; anything else is a server problem.
        if (second) setError(res.status === 429 ? "mfa_locked" : res.status === 401 ? "mfa_wrong" : "loginServerError");
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
    <main className="login-page"><div className="login">
      <div className="top"><strong className="display">{t("appName")}</strong><LanguageToggle /></div>
      <h1>{t("signIn")}</h1>
      <p>{t("tagline")}</p>
      <form onSubmit={onSubmit}>
        {challenge !== null ? (
          <>
            <p>{t("mfa_hint")}</p>
            <label>
              {t("mfa_code")}
              <input inputMode="numeric" autoComplete="one-time-code" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
          </>
        ) : (<>
        <label>
          {t("email")}
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          {t("password")}
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        </>)}
        {error && <p role="alert" className="error">{t(error)}</p>}
        <button type="submit" disabled={busy}>{challenge !== null ? t("mfa_verify") : t("signIn")}</button>
        {challenge !== null && <button type="button" className="link" onClick={() => { setChallenge(null); setCode(""); setError(null); }}>{t("mfa_back")}</button>}
      </form>
    </div></main>
  );
}
