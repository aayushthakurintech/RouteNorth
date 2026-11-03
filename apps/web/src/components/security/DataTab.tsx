"use client";
import { useState } from "react";
import { apiDownload, apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { saveSession } from "@/lib/session";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Person { id: string; email: string; displayName: string | null; role: string; disabled?: boolean }

/** Your data: download everything, erase one person's details, or delete the whole organization. */
export function DataTab() {
  const { t } = useI18n(); const { toast } = useToast(); const { me, can } = useMe();
  const people = useApi<Person[]>(can("users.manage") ? "/users?includeDisabled=1" : null);
  const [who, setWho] = useState(""); const [confirmEmail, setConfirmEmail] = useState("");
  const [pw, setPw] = useState(""); const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const person = people.data?.find((p) => p.id === who);
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { toast((e as Error).message, { tone: "error" }); } finally { setBusy(false); } };
  const exportAll = () => run(() => apiDownload("/security/export", `routenorth-export-${new Date().toISOString().slice(0, 10)}.json`));
  const erase = () => run(async () => { await apiSend("POST", `/security/users/${who}/erase`, { confirm: confirmEmail }); toast(t("sx_erased")); setWho(""); setConfirmEmail(""); people.reload(); });
  const deleteOrg = () => run(async () => { await apiSend("POST", "/security/delete-organization", { password: pw, confirm: confirmName }); saveSession(null); window.location.assign("/login"); });
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      {can("settings.manage") && (
        <section className="card stack" aria-labelledby="sx-exp-h">
          <h2 id="sx-exp-h" style={{ margin: 0 }}>{t("sx_export_title")}</h2>
          <p className="meta">{t("sx_export_note")}</p>
          <div><button type="button" className="btn" disabled={busy} onClick={() => void exportAll()}>{t("sx_export")}</button></div>
        </section>
      )}
      {can("users.manage") && (
        <section className="card stack" aria-labelledby="sx-era-h">
          <h2 id="sx-era-h" style={{ margin: 0 }}>{t("sx_erase_title")}</h2>
          <p className="meta">{t("sx_erase_note")}</p>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void erase(); }}>
            <label className="field"><span>{t("sx_erase_who")}</span>
              <select value={who} onChange={(e) => { setWho(e.target.value); setConfirmEmail(""); }} required>
                <option value="">—</option>
                {(people.data ?? []).filter((p) => p.id !== me?.user.id && !p.email.endsWith("@erased.invalid")).map((p) => <option key={p.id} value={p.id}>{p.displayName ?? p.email} ({p.email})</option>)}
              </select>
            </label>
            {person && <label className="field"><span>{t("sx_erase_confirm", { email: person.email })}</span><input value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} autoComplete="off" required /></label>}
            <div><button type="submit" className="btn danger" disabled={busy || !person || confirmEmail.toLowerCase() !== person.email.toLowerCase()}>{t("sx_erase")}</button></div>
          </form>
        </section>
      )}
      {me?.user.role === "owner" && (
        <section className="card stack" aria-labelledby="sx-del-h" style={{ borderColor: "var(--danger)" }}>
          <h2 id="sx-del-h" style={{ margin: 0 }}>{t("sx_delete_title")}</h2>
          <p>{t("sx_delete_note")}</p>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void deleteOrg(); }}>
            <label className="field"><span>{t("sx_delete_name", { name: me.org.name })}</span><input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" required /></label>
            <label className="field"><span>{t("sx_password")}</span><input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></label>
            <div><button type="submit" className="btn danger" disabled={busy || confirmName !== me.org.name || !pw}>{t("sx_delete")}</button></div>
          </form>
        </section>
      )}
    </div>
  );
}
