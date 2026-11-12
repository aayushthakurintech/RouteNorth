"use client";
import type { MessageKey } from "@routenorth/shared";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useToast } from "@/lib/toast";

export const FEEDBACK_KINDS = ["question", "bug", "idea", "praise"] as const;

/** A message to the product team. Used on the help page and in the feedback dialog. */
export function FeedbackForm({ onSent, initialKind = "idea" }: { onSent?: () => void; initialKind?: (typeof FEEDBACK_KINDS)[number] }) {
  const { t } = useI18n(); const { toast } = useToast(); const path = usePathname();
  const [kind, setKind] = useState<string>(initialKind); const [subject, setSubject] = useState(""); const [body, setBody] = useState(""); const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    try {
      const r = await apiSend<{ emailed: boolean }>("POST", "/support/requests", { kind, subject, body, page: path });
      toast(t(r.emailed ? "fb_sent_mail" : "fb_sent")); setSubject(""); setBody(""); onSent?.();
    } catch (e) { toast((e as Error).message, { tone: "error" }); } finally { setBusy(false); }
  }
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <label className="field"><span>{t("fb_kind")}</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>{FEEDBACK_KINDS.map((k) => <option key={k} value={k}>{t(`fb_k_${k}` as MessageKey)}</option>)}</select>
      </label>
      <label className="field"><span>{t("fb_subject")}</span><input value={subject} maxLength={160} onChange={(e) => setSubject(e.target.value)} /></label>
      <label className="field"><span>{t("fb_body")}</span><textarea required rows={5} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t(`fb_ph_${kind}` as MessageKey)} /></label>
      <p className="meta">{t("fb_page_note")}</p>
      <div><button type="submit" className="btn" disabled={busy || !body.trim()}>{t("fb_send")}</button></div>
    </form>
  );
}
