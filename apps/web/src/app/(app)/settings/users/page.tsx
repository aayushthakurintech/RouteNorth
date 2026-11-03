"use client";
import { Plus } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { PERMISSIONS, ROLES, type MessageKey, type Permission } from "@routenorth/shared";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Chip, EmptyState, ErrorState, Modal, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Person { id: string; email: string; displayName: string | null; role: string; locale: string; customRoleId: string | null; customRoleName: string | null; disabledAt: string | null }
interface RolesResp { permissions: Permission[]; builtIn: { role: string; permissions: Permission[] }[]; custom: { id: string; name: string; permissions: Permission[]; userCount: number }[] }

const GROUPS: { key: MessageKey; match: (p: string) => boolean }[] = [
  { key: "perm_group_fleet", match: (p) => p.startsWith("fleet.") },
  { key: "perm_group_routes", match: (p) => p.startsWith("routes.") },
  { key: "perm_group_reports", match: (p) => p.startsWith("reports.") },
  { key: "perm_group_alerts", match: (p) => p.startsWith("alerts.") },
  { key: "perm_group_customers", match: (p) => p.startsWith("customers.") },
  { key: "perm_group_people", match: (p) => p.startsWith("users.") || p.startsWith("roles.") },
  { key: "perm_group_admin", match: (p) => ["audit.view", "settings.manage", "billing.manage", "api.manage", "integrations.manage"].includes(p) },
  { key: "perm_group_apps", match: (p) => p === "driver.app" || p === "customer.portal" },
];
const permKey = (p: string) => `perm_${p.replace(".", "_")}` as MessageKey;

export default function PeoplePage() {
  const { t } = useI18n();
  const { can, me } = useMe();
  const { toast } = useToast();
  const [tab, setTab] = useState("people");
  const people = useApi<Person[]>(can("users.view") ? "/users?includeDisabled=1" : null);
  const roles = useApi<RolesResp>(can("users.view") ? "/roles" : null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ id?: string; name: string; permissions: Permission[] } | null>(null);
  const [form, setForm] = useState({ email: "", password: "", role: "dispatcher", displayName: "", customRoleId: "" });

  const manage = can("users.manage");
  const cols: Column<Person>[] = useMemo(() => [
    {
      key: "name", header: t("displayName"), value: (p) => p.displayName ?? "", width: 190, pinned: true,
      edit: manage ? async (p, v) => { await apiSend("PATCH", `/users/${p.id}`, { displayName: v || null }); people.reload(); toast(t("saved")); } : undefined,
    },
    { key: "email", header: t("email"), value: (p) => p.email, width: 240 },
    {
      key: "role", header: t("role"), value: (p) => p.customRoleName ?? t(`role_${p.role}` as MessageKey), width: 200,
      render: (p) => manage && p.id !== me?.user.id ? (
        <select
          aria-label={t("role")} value={p.customRoleId ? `c:${p.customRoleId}` : p.role}
          onClick={(e) => e.stopPropagation()}
          onChange={async (e) => {
            const v = e.target.value;
            try {
              await apiSend("PATCH", `/users/${p.id}`, v.startsWith("c:") ? { customRoleId: v.slice(2) } : { role: v, customRoleId: null });
              toast(t("saved")); people.reload();
            } catch (err) { toast((err as Error).message, { tone: "error" }); }
          }}
        >
          {ROLES.map((r) => <option key={r} value={r}>{t(`role_${r}` as MessageKey)}</option>)}
          {(roles.data?.custom ?? []).map((c) => <option key={c.id} value={`c:${c.id}`}>{c.name}</option>)}
        </select>
      ) : <Chip tone="brand">{p.customRoleName ?? t(`role_${p.role}` as MessageKey)}</Chip>,
    },
    { key: "locale", header: t("language"), value: (p) => p.locale.toUpperCase(), width: 90 },
    {
      key: "status", header: t("actions"), value: (p) => (p.disabledAt ? t("disabled") : ""), width: 150, noGroup: true,
      render: (p) => manage && p.id !== me?.user.id ? (
        <button
          type="button" className="btn ghost sm"
          onClick={async (e) => { e.stopPropagation(); try { await apiSend("PATCH", `/users/${p.id}`, { disabled: !p.disabledAt }); people.reload(); } catch (err) { toast((err as Error).message, { tone: "error" }); } }}
        >{p.disabledAt ? <Chip tone="warn">{t("enablePerson")}</Chip> : t("disablePerson")}</button>
      ) : p.disabledAt ? <Chip tone="warn">{t("disabled")}</Chip> : null,
    },
  ], [t, manage, me, people, roles.data, toast]);

  async function addPerson(e: FormEvent) {
    e.preventDefault();
    try {
      await apiSend("POST", "/users", { email: form.email, password: form.password, role: form.role, displayName: form.displayName || undefined, customRoleId: form.customRoleId || undefined });
      setAdding(false); setForm({ email: "", password: "", role: "dispatcher", displayName: "", customRoleId: "" }); people.reload(); toast(t("saved"));
    } catch (err) { toast((err as Error).message, { tone: "error" }); }
  }

  async function saveRole(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      await apiSend(editing.id ? "PUT" : "POST", editing.id ? `/roles/${editing.id}` : "/roles", { name: editing.name, permissions: editing.permissions });
      setEditing(null); roles.reload(); toast(t("saved"));
    } catch (err) { toast((err as Error).message, { tone: "error" }); }
  }

  if (!can("users.view")) return <div className="content"><ErrorState forbidden /></div>;
  return (
    <div className="content">
      <PageHead
        title={t("navUsers")}
        actions={tab === "people" ? (manage && <button type="button" className="btn" onClick={() => setAdding(true)}><Plus size={16} aria-hidden />{t("addPerson")}</button>)
          : can("roles.manage") && <button type="button" className="btn" onClick={() => setEditing({ name: "", permissions: ["fleet.view"] })}><Plus size={16} aria-hidden />{t("newRole")}</button>}
      />
      <Tabs label={t("navUsers")} value={tab} onChange={setTab} tabs={[{ id: "people", label: t("people") }, { id: "roles", label: t("roles") }]} />

      {tab === "people" && (
        <div role="tabpanel" id="panel-people" aria-labelledby="tab-people">
          {!people.loaded && !people.error ? <SkeletonList rows={5} h={38} /> : people.error && !people.loaded ? <ErrorState error={people.error} onRetry={people.reload} /> : (
            <DataTable tableId="people" columns={cols} rows={people.data ?? []} rowKey={(p) => p.id} empty={<EmptyState title={t("emptyTitle")} />} />
          )}
        </div>
      )}

      {tab === "roles" && (
        <div role="tabpanel" id="panel-roles" aria-labelledby="tab-roles" className="stack">
          <h2>{t("builtInRoles")}</h2>
          <div className="grid cols-3">
            {(roles.data?.builtIn ?? []).map((r) => (
              <div key={r.role} className="card">
                <div className="card-head"><h2>{t(`role_${r.role}` as MessageKey)}</h2><span className="chip">{r.permissions.length}</span></div>
                <ul style={{ margin: 0, paddingInlineStart: 18, color: "var(--fg-2)", fontSize: 13 }}>
                  {r.permissions.slice(0, 6).map((p) => <li key={p}>{t(permKey(p))}</li>)}
                  {r.permissions.length > 6 && <li className="meta">+{r.permissions.length - 6}</li>}
                </ul>
              </div>
            ))}
          </div>
          <h2>{t("customRoles")}</h2>
          {(roles.data?.custom.length ?? 0) === 0 ? <EmptyState title={t("noCustomRoles")} /> : (
            <div className="grid cols-3">
              {roles.data!.custom.map((r) => (
                <div key={r.id} className="card">
                  <div className="card-head"><h2>{r.name}</h2><span className="chip">{t("usersAssigned", { n: r.userCount })}</span></div>
                  <span className="meta">{r.permissions.length} / {PERMISSIONS.length}</span>
                  {can("roles.manage") && (
                    <div className="row">
                      <button type="button" className="btn alt sm" onClick={() => setEditing({ id: r.id, name: r.name, permissions: r.permissions })}>{t("edit")}</button>
                      <button type="button" className="btn danger outline sm" onClick={async () => { if (window.confirm(r.name)) { await apiSend("DELETE", `/roles/${r.id}`); roles.reload(); people.reload(); } }}>{t("delete")}</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Modal
        open={adding} onClose={() => setAdding(false)} title={t("addPerson")}
        actions={<><button type="button" className="btn alt" onClick={() => setAdding(false)}>{t("cancel")}</button><button type="submit" form="add-person" className="btn">{t("create")}</button></>}
      >
        <form id="add-person" className="stack" onSubmit={addPerson}>
          <label className="field">{t("displayName")}<input value={form.displayName} maxLength={80} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
          <label className="field">{t("email")}<input type="email" required autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="field">{t("initialPassword")}<input type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <label className="field">{t("role")}
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.filter((r) => r !== "owner").map((r) => <option key={r} value={r}>{t(`role_${r}` as MessageKey)}</option>)}
            </select>
          </label>
          {(roles.data?.custom.length ?? 0) > 0 && (
            <label className="field">{t("customRole")}
              <select value={form.customRoleId} onChange={(e) => setForm({ ...form, customRoleId: e.target.value })}>
                <option value="">{t("noCustomRole")}</option>
                {roles.data!.custom.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
        </form>
      </Modal>

      <Modal
        open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? editing.name : t("newRole")}
        actions={<><button type="button" className="btn alt" onClick={() => setEditing(null)}>{t("cancel")}</button><button type="submit" form="edit-role" className="btn">{t("save")}</button></>}
      >
        {editing && (
          <form id="edit-role" className="stack" onSubmit={saveRole}>
            <label className="field">{t("roleName")}<input required maxLength={60} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            {GROUPS.map((g) => (
              <fieldset key={g.key} style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="meta" style={{ fontWeight: 600 }}>{t(g.key)}</legend>
                {PERMISSIONS.filter((p) => g.match(p)).map((p) => (
                  <label key={p} className="check" style={{ padding: "3px 0" }}>
                    <input
                      type="checkbox" checked={editing.permissions.includes(p)}
                      onChange={(e) => setEditing({ ...editing, permissions: e.target.checked ? [...editing.permissions, p] : editing.permissions.filter((x) => x !== p) })}
                    />{t(permKey(p))}
                  </label>
                ))}
              </fieldset>
            ))}
          </form>
        )}
      </Modal>
    </div>
  );
}
