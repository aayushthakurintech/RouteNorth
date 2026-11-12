"use client";
import type { MessageKey } from "@routenorth/shared";
import { Pencil, Plus, Trash2, UsersRound } from "lucide-react";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, Modal, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Team { id: string; name: string; kind: string; depotId: string | null; depotName: string | null; color: string | null; notes: string | null; vehicleCount: number; openJobs: number; members: { id: string; name: string; role: string }[] }
interface Person { id: string; displayName: string | null; email: string; role: string }
const KINDS = ["team", "region", "depot_group"];

export function TeamsTab() {
  const { t } = useI18n(); const { toast } = useToast(); const { can } = useMe();
  const teams = useApi<Team[]>("/teams");
  const depots = useApi<{ id: string; name: string }[]>("/r/depots");
  const canEdit = can("users.manage");
  const people = useApi<Person[]>(canEdit ? "/users" : null);
  const [edit, setEdit] = useState<{ id?: string; name: string; kind: string; depotId: string; color: string; notes: string } | null>(null);
  const [members, setMembers] = useState<{ team: Team; ids: Set<string> } | null>(null);
  async function save() {
    if (!edit) return;
    const body = { name: edit.name, kind: edit.kind, depotId: edit.depotId || null, color: edit.color || null, notes: edit.notes || null };
    try { if (edit.id) await apiSend("PATCH", `/teams/${edit.id}`, body); else await apiSend("POST", "/teams", body); setEdit(null); teams.reload(); toast(t("rSaved")); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function remove(tm: Team) {
    if (!window.confirm(t("tm_deleteAsk", { name: tm.name }))) return;
    try { await apiSend("DELETE", `/teams/${tm.id}`); teams.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function saveMembers() {
    if (!members) return;
    try { await apiSend("PUT", `/teams/${members.team.id}/members`, { userIds: [...members.ids] }); setMembers(null); teams.reload(); toast(t("rSaved")); } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  return (
    <div className="stack">
      <p className="meta small">{t("tm_teamsNote")}</p>
      {canEdit && <div><button type="button" className="btn" onClick={() => setEdit({ name: "", kind: "team", depotId: "", color: "", notes: "" })}><Plus size={16} aria-hidden /> {t("tm_newTeam")}</button></div>}
      {teams.error && !teams.loaded && <ErrorState error={teams.error} onRetry={teams.reload} />}
      {!teams.loaded && !teams.error && <SkeletonList rows={3} />}
      {teams.loaded && teams.data!.length === 0 && <EmptyState title={t("tm_noTeams")} body={t("tm_noTeamsBody")} />}
      {teams.data && teams.data.length > 0 && (
        <table className="ptable"><thead><tr><th>{t("f_name")}</th><th>{t("tm_kind")}</th><th>{t("tm_depot")}</th><th>{t("tm_people")}</th><th className="tnum">{t("tm_vehicles")}</th><th className="tnum">{t("tm_openJobs")}</th><th><span className="sr-only">{t("actions")}</span></th></tr></thead><tbody>
          {teams.data.map((tm) => (
            <tr key={tm.id}>
              <td><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: tm.color ?? "var(--line-strong)", marginInlineEnd: 8 }} aria-hidden />{tm.name}</td>
              <td><Chip>{t(`tm_k_${tm.kind}` as MessageKey)}</Chip></td><td>{tm.depotName ?? "–"}</td>
              <td title={tm.members.map((m) => m.name).join(", ")}>{tm.members.length === 0 ? "–" : tm.members.slice(0, 3).map((m) => m.name).join(", ") + (tm.members.length > 3 ? ` +${tm.members.length - 3}` : "")}</td>
              <td className="tnum">{tm.vehicleCount}</td><td className="tnum">{tm.openJobs}</td>
              <td>{canEdit && <span className="row" style={{ gap: 2 }}>
                <button type="button" className="btn sm ghost" aria-label={`${t("tm_members")}: ${tm.name}`} onClick={() => setMembers({ team: tm, ids: new Set(tm.members.map((m) => m.id)) })}><UsersRound size={14} aria-hidden /></button>
                <button type="button" className="btn sm ghost" aria-label={`${t("rEdit")}: ${tm.name}`} onClick={() => setEdit({ id: tm.id, name: tm.name, kind: tm.kind, depotId: tm.depotId ?? "", color: tm.color ?? "", notes: tm.notes ?? "" })}><Pencil size={14} aria-hidden /></button>
                <button type="button" className="btn sm ghost" aria-label={`${t("rDelete")}: ${tm.name}`} onClick={() => remove(tm)}><Trash2 size={14} aria-hidden /></button></span>}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      <p className="meta small">{t("tm_filterNote")}</p>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? t("tm_editTeam") : t("tm_newTeam")}
        actions={<><button type="button" className="btn alt" onClick={() => setEdit(null)}>{t("cancel")}</button><button type="submit" form="team-form" className="btn">{t("save")}</button></>}>
        {edit && <form id="team-form" className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="field"><span>{t("f_name")} *</span><input required maxLength={120} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <label className="field"><span>{t("tm_kind")}</span><select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{t(`tm_k_${k}` as MessageKey)}</option>)}</select></label>
          <label className="field"><span>{t("tm_depot")}</span><select value={edit.depotId} onChange={(e) => setEdit({ ...edit, depotId: e.target.value })}><option value="">{t("rNone")}</option>{(depots.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label className="field"><span>{t("tm_color")}</span><input type="color" value={edit.color || "#3b82f6"} onChange={(e) => setEdit({ ...edit, color: e.target.value })} /></label>
          <label className="field"><span>{t("f_notes")}</span><textarea rows={2} maxLength={1000} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
        </form>}
      </Modal>
      <Modal open={!!members} onClose={() => setMembers(null)} title={members ? `${t("tm_members")}: ${members.team.name}` : ""}
        actions={<><button type="button" className="btn alt" onClick={() => setMembers(null)}>{t("cancel")}</button><button type="button" className="btn" onClick={saveMembers}>{t("save")}</button></>}>
        {members && <div className="stack" role="group" aria-label={t("tm_members")}>
          {(people.data ?? []).filter((p) => p.role !== "customer").map((p) => (
            <label key={p.id} className="row" style={{ gap: 8 }}><input type="checkbox" checked={members.ids.has(p.id)} onChange={(e) => { const n = new Set(members.ids); if (e.target.checked) n.add(p.id); else n.delete(p.id); setMembers({ ...members, ids: n }); }} /> {p.displayName ?? p.email} <span className="meta small">{t(`role_${p.role}` as MessageKey)}</span></label>
          ))}
        </div>}
      </Modal>
    </div>
  );
}
