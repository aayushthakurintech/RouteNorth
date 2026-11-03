"use client";
import { Send, Trash2 } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Comment { id: string; body: string; createdAt: string; userId: string | null; author: string | null }
interface Person { id: string; name: string; handle: string }
export type CommentEntity = "job" | "vehicle" | "driver" | "invoice" | "task" | "incident";

/** Show @handle in a comment as a highlighted mention. */
function withMentions(body: string, handles: Set<string>): ReactNode[] {
  return body.split(/(^|[^\w@.])(@[A-Za-z0-9][A-Za-z0-9._-]{0,63})/g).reduce<ReactNode[]>((out, part, i, all) => {
    if (i % 3 === 2) { const h = part.slice(1).toLowerCase().replace(/[._-]+$/, ""); out.push(handles.has(h) ? <span key={i} className="mention">{part}</span> : part); }
    else if (i % 3 === 1) out.push(part);
    else out.push(part);
    void all; return out;
  }, []);
}

/** Notes between teammates on a record. Type @ and a name to bring someone in; they get a notification. */
export function CommentsPanel({ entity, entityId }: { entity: CommentEntity; entityId: string }) {
  const { t, locale } = useI18n(); const { toast } = useToast(); const { can, me } = useMe();
  const list = useApi<Comment[]>(`/comments?entity=${entity}&entityId=${entityId}`);
  const people = useApi<Person[]>("/comments/people");
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const handles = useMemo(() => new Set((people.data ?? []).map((p) => p.handle)), [people.data]);
  const match = /(?:^|\s)@([A-Za-z0-9._-]*)$/.exec(text);
  const options = match ? (people.data ?? []).filter((p) => p.handle.startsWith(match[1]!.toLowerCase()) || p.name.toLowerCase().includes(match[1]!.toLowerCase())).slice(0, 5) : [];
  const writeOk = entity === "job" || entity === "task" ? can("routes.write") : entity === "invoice" ? can("customers.manage") : can("fleet.manage");
  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    try { await apiSend("POST", "/comments", { entity, entityId, body: text.trim() }); setText(""); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } finally { setBusy(false); }
  }
  async function remove(id: string) { try { await apiSend("DELETE", `/comments/${id}`); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <section className="stack" aria-label={t("cm_title")} style={{ marginTop: 12 }}>
      <h3 style={{ margin: 0 }}>{t("cm_title")}</h3>
      {list.loaded && list.data!.length === 0 && <p className="meta small">{t("cm_none")}</p>}
      <div>
        {(list.data ?? []).map((c) => (
          <div className="comment" key={c.id}>
            <span className="who">{c.author ?? "–"}</span><span className="when">{new Date(c.createdAt).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" })}</span>
            {(c.userId === me?.user.id || can("users.manage")) && <button type="button" className="btn sm ghost" style={{ float: "inline-end" as never }} aria-label={t("rDelete")} onClick={() => remove(c.id)}><Trash2 size={13} aria-hidden /></button>}
            <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{withMentions(c.body, handles)}</div>
          </div>
        ))}
      </div>
      {writeOk && (
        <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="stack" style={{ gap: 6 }}>
          <label className="field"><span className="sr-only">{t("cm_write")}</span>
            <textarea ref={ta} rows={2} maxLength={2000} placeholder={t("cm_placeholder")} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} /></label>
          {options.length > 0 && <div className="row" role="listbox" aria-label={t("cm_people")} style={{ gap: 4, flexWrap: "wrap" }}>
            {options.map((p) => <button key={p.id} type="button" role="option" aria-selected="false" className="btn sm alt" onClick={() => { setText(text.replace(/@[A-Za-z0-9._-]*$/, `@${p.handle} `)); ta.current?.focus(); }}>@{p.handle} <span className="meta small">{p.name}</span></button>)}
          </div>}
          <div><button type="submit" className="btn sm" disabled={busy || !text.trim()}><Send size={14} aria-hidden /> {t("cm_send")}</button></div>
        </form>
      )}
    </section>
  );
}
