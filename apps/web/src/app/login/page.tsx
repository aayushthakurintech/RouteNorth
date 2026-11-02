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
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { token, user } = await res.json();
      saveSession({ token, locale: user.locale, role: user.role });
      setLocale(user.locale);
      router.replace(user.role === "driver" ? "/driver" : "/");
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <LanguageToggle />
      <h1>{t("appName")}</h1>
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
        {error && <p role="alert" className="error">{t("loginFailed")}</p>}
        <button type="submit" disabled={busy}>{t("signIn")}</button>
      </form>
    </main>
  );
}
