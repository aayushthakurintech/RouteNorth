"use client";
import type { MessageKey } from "@routenorth/shared";
import { useRouter } from "next/navigation";
import { use, useEffect, useState, type FormEvent } from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useI18n } from "@/lib/i18n-context";
import { API_URL, saveSession } from "@/lib/session";

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { t, setLocale, locale } = useI18n();
  const router = useRouter();
  const [info, setInfo] = useState<{ email: string; role: string; orgName: string } | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "gone" | "down">("loading");
  const [name, setName] = useState(""); const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`${API_URL}/public/invite/${encodeURIComponent(token)}`)
      .then(async (r) => { if (!live) return; if (r.ok) { setInfo(await r.json()); setState("ok"); } else setState(r.status === 404 ? "gone" : "down"); })
      .catch(() => live && setState("down"));
    return () => { live = false; };
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (pw.length < 10) return setErr(t("inv_short"));
    if (pw !== pw2) return setErr(t("inv_mismatch"));
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/public/invite/${encodeURIComponent(token)}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw, displayName: name || undefined, locale }) });
      if (!res.ok) { setErr(res.status === 404 ? t("inv_gone") : t("loginServerError")); return; }
      const { token: jwt, user } = await res.json();
      saveSession({ token: jwt, locale: user.locale, role: user.role });
      setLocale(user.locale);
      router.replace(user.home ?? "/live");
    } catch { setErr(t("loginUnreachable")); } finally { setBusy(false); }
  }

  return (
    <main className="login-page"><div className="login">
      <div className="top"><strong className="display">{t("appName")}</strong><LanguageToggle /></div>
      {state === "loading" && <p role="status">…</p>}
      {state === "gone" && <><h1>{t("inv_goneTitle")}</h1><p>{t("inv_gone")}</p></>}
      {state === "down" && <p role="alert" className="error">{t("loginUnreachable")}</p>}
      {state === "ok" && info && (
        <>
          <h1>{t("inv_title", { org: info.orgName })}</h1>
          <p>{t("inv_body", { email: info.email, role: t(`role_${info.role}` as MessageKey) })}</p>
          <form onSubmit={submit}>
            <label>{t("inv_name")}<input autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>{t("password")}<input type="password" autoComplete="new-password" required minLength={10} maxLength={200} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
            <label>{t("inv_again")}<input type="password" autoComplete="new-password" required minLength={10} maxLength={200} value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
            <p className="meta small">{t("inv_rule")}</p>
            {err && <p role="alert" className="error">{err}</p>}
            <button type="submit" disabled={busy}>{t("inv_join")}</button>
          </form>
        </>
      )}
    </div></main>
  );
}
