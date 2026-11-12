"use client";
import { useState } from "react";
import { ErrorState, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Status { enabled: boolean; enabledAt: string | null; recoveryLeft: number; required: boolean }

/** Turn on a second step at sign-in with an authenticator app, keep recovery codes, and (for managers) require it for everyone. */
export function TwoFactorTab() {
  const { t } = useI18n(); const { toast } = useToast(); const { can, reload } = useMe();
  const st = useApi<Status>("/security/2fa");
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  if (st.error && !st.loaded) return <ErrorState error={st.error} onRetry={st.reload} />;
  if (!st.data) return <SkeletonList rows={3} />;
  const s = st.data;
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { toast((e as Error).message, { tone: "error" }); } finally { setBusy(false); } };
  const start = () => run(async () => { setSetup(await apiSend("POST", "/security/2fa/setup")); setCode(""); });
  const enable = () => run(async () => { const r = await apiSend<{ recoveryCodes: string[] }>("POST", "/security/2fa/enable", { code }); setCodes(r.recoveryCodes); setSetup(null); st.reload(); reload(); });
  const disable = () => run(async () => { await apiSend("POST", "/security/2fa/disable", { password }); setPassword(""); setCodes(null); toast(t("sx_off_done")); st.reload(); reload(); });
  const again = () => run(async () => { const r = await apiSend<{ recoveryCodes: string[] }>("POST", "/security/2fa/recovery", { password }); setCodes(r.recoveryCodes); setPassword(""); st.reload(); });
  const require = (on: boolean) => run(async () => { await apiSend("PUT", "/org", { settings: { twoFactorRequired: on } }); toast(t("settingsSaved")); st.reload(); reload(); });
  const download = () => {
    const url = URL.createObjectURL(new Blob([`RouteNorth recovery codes\n\n${(codes ?? []).join("\n")}\n`], { type: "text/plain" }));
    const a = document.createElement("a"); a.href = url; a.download = "routenorth-recovery-codes.txt"; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <p>{t("sx_2fa_intro")}</p>
      <section className="card stack" aria-labelledby="sx-2fa-h">
        <h2 id="sx-2fa-h" style={{ margin: 0 }}>{t("sx_2fa_title")} <span className={`chip ${s.enabled ? "ok" : ""}`}>{s.enabled ? t("sx_on") : t("sx_off")}</span></h2>
        {codes && (
          <div role="status" className="stack">
            <strong>{t("sx_codes_title")}</strong>
            <p className="meta">{t("sx_codes_note")}</p>
            <ul className="mono" style={{ columns: 2, listStyle: "none", padding: 0, margin: 0 }}>{codes.map((c) => <li key={c}>{c}</li>)}</ul>
            <div className="row"><button type="button" className="btn alt" onClick={download}>{t("sx_codes_download")}</button><button type="button" className="btn" onClick={() => setCodes(null)}>{t("sx_codes_saved")}</button></div>
          </div>
        )}
        {!s.enabled && !setup && <div><button type="button" className="btn" disabled={busy} onClick={start}>{t("sx_setup")}</button></div>}
        {setup && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void enable(); }}>
            <ol className="stack" style={{ paddingInlineStart: 20, margin: 0 }}>
              <li>{t("sx_step1")}</li>
              <li>{t("sx_step2")} <code className="mono" aria-label={t("sx_key")}>{setup.secret}</code> <a href={setup.otpauth}>{t("sx_open_app")}</a></li>
              <li>{t("sx_step3")}</li>
            </ol>
            <label className="field"><span>{t("sx_code")}</span><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <div className="row"><button type="submit" className="btn" disabled={busy}>{t("sx_turn_on")}</button><button type="button" className="btn alt" onClick={() => setSetup(null)}>{t("cancel")}</button></div>
          </form>
        )}
        {s.enabled && !codes && (
          <form className="stack" onSubmit={(e) => e.preventDefault()}>
            <p className="meta">{t("sx_recovery_left", { n: s.recoveryLeft })}</p>
            <label className="field"><span>{t("sx_password")}</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <div className="row">
              <button type="button" className="btn alt" disabled={busy || !password} onClick={again}>{t("sx_new_codes")}</button>
              <button type="button" className="btn danger" disabled={busy || !password} onClick={disable}>{t("sx_turn_off")}</button>
            </div>
          </form>
        )}
      </section>
      {can("settings.manage") && (
        <section className="card stack" aria-labelledby="sx-req-h">
          <h2 id="sx-req-h" style={{ margin: 0 }}>{t("sx_require_title")}</h2>
          <p className="meta">{t("sx_require_note")}</p>
          <label className="check"><input type="checkbox" className="switch" checked={s.required} disabled={busy || (!s.enabled && !s.required)} onChange={(e) => void require(e.target.checked)} /> {t("sx_require")}</label>
          {!s.enabled && !s.required && <p className="meta">{t("sx_require_first")}</p>}
        </section>
      )}
    </div>
  );
}
