"use client";
import { useEffect, useState, type FormEvent } from "react";
import { LOCALES, LOCALE_NAMES, type Locale } from "@routenorth/shared";
import { PageHead } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";

export default function ProfilePage() {
  const { t, setLocale, locale } = useI18n();
  const { me, reload } = useMe();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  useEffect(() => { setName(me?.user.displayName ?? ""); }, [me]);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    try { await apiSend("PATCH", "/me", { displayName: name, locale }); reload(); toast(t("saved")); } catch (err) { toast((err as Error).message, { tone: "error" }); }
  }
  async function changePassword(e: FormEvent) {
    e.preventDefault();
    try { await apiSend("POST", "/me/password", { current, next }); setCurrent(""); setNext(""); toast(t("passwordChanged")); } catch (err) { toast((err as Error).message, { tone: "error" }); }
  }
  return (
    <div className="content" style={{ maxWidth: 640 }}>
      <PageHead title={t("profile")} subtitle={me?.user.email} />
      <form className="card" onSubmit={saveProfile}>
        <label className="field">{t("displayName")}<input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">{t("language")}
          <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>{LOCALES.map((l) => <option key={l} value={l} lang={l}>{LOCALE_NAMES[l]}</option>)}</select>
        </label>
        <div><button type="submit" className="btn">{t("save")}</button></div>
      </form>
      <form className="card" onSubmit={changePassword}>
        <h2>{t("changePassword")}</h2>
        <label className="field">{t("currentPassword")}<input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label className="field">{t("newPassword")}<input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <div><button type="submit" className="btn">{t("changePassword")}</button></div>
      </form>
    </div>
  );
}
