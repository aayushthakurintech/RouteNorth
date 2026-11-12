"use client";
import type { MessageKey } from "@routenorth/shared";
import { Copy } from "lucide-react";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Invite { id: string; email: string; role: string; teamName: string | null; expiresAt: string; acceptedAt: string | null; revokedAt: string | null; open: boolean }
const ROLES = ["admin", "dispatcher", "manager", "accountant", "driver", "customer", "viewer"];

export function InvitesTab() {
  const { t, locale } = useI18n(); const { toast } = useToast(); const { me } = useMe();
  const list = useApi<Invite[]>("/invites");
  const teams = useApi<{ id: string; name: string }[]>("/teams");
  const [f, setF] = useState({ email: "", role: "dispatcher", teamId: "" });
  const [made, setMade] = useState<{ link: string; email: string; emailSent: boolean } | null>(null);
  const isOwner = me?.user.role === "owner";
  async function create() {
    try {
      const r = await apiSend<{ link: string; email: string; emailSent: boolean }>("POST", "/invites", { email: f.email, role: f.role, teamId: f.teamId || undefined });
      setMade(r); setF({ ...f, email: "" }); list.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function revoke(id: string) { try { await apiSend("DELETE", `/invites/${id}`); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  const day = (iso: string) => new Date(iso).toLocaleDateString(locale === "fr" ? "fr-CA" : "en-CA");
  return (
    <div className="stack">
      <p className="meta small">{t("tm_inviteNote")}</p>
      <form className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label className="field"><span>{t("bl_email")} *</span><input required type="email" maxLength={200} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="field"><span>{t("tm_role")}</span><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.filter((r) => r !== "admin" || isOwner).map((r) => <option key={r} value={r}>{t(`role_${r}` as MessageKey)}</option>)}</select></label>
        <label className="field"><span>{t("tm_team")}</span><select value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}><option value="">{t("rNone")}</option>{(teams.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <button type="submit" className="btn">{t("tm_invite")}</button>
      </form>
      {made && (
        <div className="banner info" role="status">
          <p>{made.emailSent ? t("tm_inviteSent", { email: made.email }) : t("tm_inviteLink", { email: made.email })}</p>
          <div className="row" style={{ gap: 8 }}><input readOnly aria-label={t("tm_linkLabel")} value={made.link} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1 }} />
            <button type="button" className="btn" onClick={() => { void navigator.clipboard?.writeText(made.link); toast(t("integ_copied")); }}><Copy size={14} aria-hidden /> {t("integ_copy")}</button></div>
          <p className="meta small">{t("tm_linkOnce")}</p>
        </div>
      )}
      {list.error && !list.loaded && <ErrorState error={list.error} onRetry={list.reload} />}
      {!list.loaded && !list.error && <SkeletonList rows={3} />}
      {list.loaded && list.data!.length === 0 && <EmptyState title={t("tm_noInvites")} />}
      {list.data && list.data.length > 0 && (
        <table className="ptable"><thead><tr><th>{t("bl_email")}</th><th>{t("tm_role")}</th><th>{t("tm_team")}</th><th>{t("tm_expires")}</th><th>{t("status")}</th><th><span className="sr-only">{t("actions")}</span></th></tr></thead><tbody>
          {list.data.map((i) => (
            <tr key={i.id}><td>{i.email}</td><td>{t(`role_${i.role}` as MessageKey)}</td><td>{i.teamName ?? "–"}</td><td>{day(i.expiresAt)}</td>
              <td><Chip tone={i.acceptedAt ? "ok" : i.open ? "info" : undefined}>{t(i.acceptedAt ? "tm_is_accepted" : i.revokedAt ? "tm_is_revoked" : i.open ? "tm_is_open" : "tm_is_expired")}</Chip></td>
              <td>{i.open && <button type="button" className="btn sm ghost" onClick={() => revoke(i.id)}>{t("tm_revoke")}</button>}</td></tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}
