"use client";
import Link from "next/link";
import { passwordProblem } from "@routenorth/shared";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AuthShell } from "@/components/auth/AuthShell";
import { PasswordField } from "@/components/auth/PasswordField";
import { useI18n } from "@/lib/i18n-context";
import { API_URL, saveSession } from "@/lib/session";

export default function SignupPage() {
  const { t, locale, setLocale } = useI18n();
  const router = useRouter();
  const [company, setCompany] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agree, setAgree] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null); setTaken(false);
    const problem = passwordProblem(password, { email, name, company });
    if (problem) return setError(t(`au_pw_${problem}`));
    if (!agree) return setError(t("au_agree_required"));
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/auth/signup`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ company: company.trim(), name: name.trim(), email: email.trim(), password, locale, acceptTerms: agree, marketing }),
      });
      if (res.status === 409) { setTaken(true); setError(t("au_taken")); return; }
      if (res.status === 429) { setError(t("au_rate")); return; }
      if (!res.ok) { setError(res.status === 400 ? ((await res.json().catch(() => null))?.message ?? t("loginServerError")) : t("loginServerError")); return; }
      const { token, user } = await res.json();
      saveSession({ token, locale: user.locale, role: user.role });
      setLocale(user.locale);
      router.replace(user.home ?? "/");
    } catch {
      setError(t("loginUnreachable"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t("au_signup_title")} subtitle={t("au_signup_sub")} footer={<>{t("au_have")} <Link href="/login">{t("signIn")}</Link></>}>
      <form onSubmit={onSubmit}>
        <div><label htmlFor="su-company">{t("au_company")}</label><input id="su-company" type="text" autoComplete="organization" autoFocus required minLength={2} maxLength={100} value={company} onChange={(e) => setCompany(e.target.value)} /></div>
        <div><label htmlFor="su-name">{t("au_yourname")}</label><input id="su-name" type="text" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label htmlFor="su-email">{t("au_workemail")}</label><input id="su-email" type="email" autoComplete="email" required maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={taken || undefined} /></div>
        <PasswordField id="su-password" label={t("au_pw_new")} value={password} onChange={setPassword} autoComplete="new-password" meter context={{ email, name, company }} hint={t("au_pw_hint")} />
        <label className="check" htmlFor="su-agree">
          <input id="su-agree" type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>{t("au_agree")} <Link href="/terms" target="_blank">{t("au_terms_link")}</Link> {t("au_and")} <Link href="/privacy" target="_blank">{t("au_privacy_link")}</Link>.</span>
        </label>
        <label className="check" htmlFor="su-marketing">
          <input id="su-marketing" type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
          <span>{t("au_marketing")}</span>
        </label>
        {error && <p role="alert" className="error">{error}{taken && <> <Link href="/login">{t("signIn")}</Link></>}</p>}
        <button type="submit" disabled={busy}>{t("au_create_btn")}</button>
      </form>
    </AuthShell>
  );
}
