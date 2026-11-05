"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthShell } from "@/components/auth/AuthShell";
import { useI18n } from "@/lib/i18n-context";
import { API_URL } from "@/lib/session";

export default function ForgotPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API_URL}/auth/forgot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim() }) });
      if (res.status === 429) setError(t("au_rate"));
      else if (!res.ok) setError(t("loginServerError"));
      else setSent(true);
    } catch { setError(t("loginUnreachable")); } finally { setBusy(false); }
  }

  if (sent) {
    return (
      <AuthShell title={t("au_forgot_done_title")} footer={<Link href="/login">{t("au_back_signin")}</Link>}>
        <p role="status" className="notice">{t("au_forgot_done", { email: email.trim() })}</p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t("au_forgot_title")} subtitle={t("au_forgot_sub")} footer={<Link href="/login">{t("au_back_signin")}</Link>}>
      <form onSubmit={onSubmit}>
        <div><label htmlFor="fg-email">{t("email")}</label><input id="fg-email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" disabled={busy}>{t("au_send_link")}</button>
      </form>
    </AuthShell>
  );
}
