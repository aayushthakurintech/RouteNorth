"use client";
import Link from "next/link";
import { passwordProblem } from "@routenorth/shared";
import { useRouter } from "next/navigation";
import { use, useState, type FormEvent } from "react";
import { AuthShell } from "@/components/auth/AuthShell";
import { PasswordField } from "@/components/auth/PasswordField";
import { useI18n } from "@/lib/i18n-context";
import { API_URL } from "@/lib/session";

export default function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { t } = useI18n();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const problem = passwordProblem(password);
    if (problem) return setError(t(`au_pw_${problem}`));
    if (password !== again) return setError(t("au_mismatch"));
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/auth/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password }) });
      if (res.ok) { router.replace("/login?reset=1"); return; }
      if (res.status === 429) setError(t("au_rate"));
      else if (res.status === 400 && /expired|valid/.test((await res.json().catch(() => ({})))?.message ?? "")) setGone(true);
      else setError(t("loginServerError"));
    } catch { setError(t("loginUnreachable")); } finally { setBusy(false); }
  }

  if (gone) {
    return (
      <AuthShell title={t("au_reset_bad")} footer={<Link href="/login">{t("au_back_signin")}</Link>}>
        <Link href="/forgot" className="btn primary" style={{ textAlign: "center", textDecoration: "none", padding: "12px 16px", borderRadius: "var(--r)", background: "var(--brand)", color: "var(--brand-fg)" }}>{t("au_reset_new")}</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t("au_reset_title")}>
      <form onSubmit={onSubmit}>
        <PasswordField id="rs-password" label={t("au_pw_new")} value={password} onChange={setPassword} autoComplete="new-password" meter hint={t("au_pw_hint")} />
        <PasswordField id="rs-again" label={t("au_confirm_pw")} value={again} onChange={setAgain} autoComplete="new-password" invalid={again.length > 0 && again !== password} />
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" disabled={busy}>{t("au_reset_btn")}</button>
      </form>
    </AuthShell>
  );
}
