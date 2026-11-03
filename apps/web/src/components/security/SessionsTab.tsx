"use client";
import { ErrorState, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Sess { id: string; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null; current: boolean }

/** A short name for a browser, from its user agent text. */
export function deviceName(ua: string | null): string {
  if (!ua) return "—";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" · ") || ua.slice(0, 40);
}

/** Where you are signed in, with a way to sign out any device. */
export function SessionsTab() {
  const { t, locale } = useI18n(); const { toast } = useToast();
  const list = useApi<Sess[]>("/security/sessions");
  if (list.error && !list.loaded) return <ErrorState error={list.error} onRetry={list.reload} />;
  if (!list.data) return <SkeletonList rows={3} />;
  const fmt = (d: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(d));
  const revoke = async (id: string) => { try { await apiSend("DELETE", `/security/sessions/${id}`); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } };
  const others = async () => { try { const r = await apiSend<{ revoked: number }>("POST", "/security/sessions/revoke-others"); toast(t("sx_signed_out_n", { n: r.revoked })); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } };
  return (
    <div className="stack">
      <p>{t("sx_sessions_note")}</p>
      <table className="ptable">
        <caption className="sr-only">{t("sx_tab_sessions")}</caption>
        <thead><tr><th scope="col">{t("sx_device")}</th><th scope="col">{t("sx_ip")}</th><th scope="col">{t("sx_signed_in")}</th><th scope="col">{t("sx_last_seen")}</th><th scope="col"><span className="sr-only">{t("actions")}</span></th></tr></thead>
        <tbody>
          {list.data.map((s) => (
            <tr key={s.id}>
              <td>{deviceName(s.userAgent)} {s.current && <span className="chip ok">{t("sx_this_device")}</span>}</td>
              <td>{s.ip ?? "—"}</td><td>{fmt(s.createdAt)}</td><td>{fmt(s.lastSeenAt)}</td>
              <td>{!s.current && <button type="button" className="btn sm alt" onClick={() => void revoke(s.id)}>{t("sx_sign_out")}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data.length > 1 && <div><button type="button" className="btn" onClick={() => void others()}>{t("sx_sign_out_others")}</button></div>}
    </div>
  );
}
