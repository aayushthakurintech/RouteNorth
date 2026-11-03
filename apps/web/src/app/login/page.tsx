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
  const [error, setError] = useState<"loginFailed" | "loginUnreachable" | "loginServerError" | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        // Only a 401 means the credentials were wrong; anything else is a server problem.
        setError(res.status === 401 ? "loginFailed" : "loginServerError");
        return;
      }
      const { token, user } = await res.json();
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
        <label>
          {t("email")}
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          {t("password")}
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p role="alert" className="error">{t(error)}</p>}
        <button type="submit" disabled={busy}>{t("signIn")}</button>
      </form>
    </div></main>
  );
}
