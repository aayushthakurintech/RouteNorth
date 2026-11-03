"use client";
import { BellRing, Check } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useApi } from "@/lib/use-api";

interface Item { id: string; kind: string; title: string; link: string | null; readAt: string | null; createdAt: string }

/** The bell with a person's own notifications: mentions, tasks given to them, answers about time off. */
export function Notifications() {
  const { t, locale } = useI18n();
  const count = useApi<{ unread: number }>("/notifications/count", { intervalMs: 45_000 });
  const [open, setOpen] = useState(false);
  const list = useApi<Item[]>(open ? "/notifications" : null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const n = count.data?.unread ?? 0;
  async function readAll() { try { await apiSend("POST", "/notifications/read", { all: true }); list.reload(); count.reload(); } catch { /* the list stays as it was */ } }
  async function readOne(id: string) { try { await apiSend("POST", "/notifications/read", { ids: [id] }); count.reload(); } catch { /* ignore */ } }
  return (
    <div className="rel" ref={ref}>
      <button type="button" className="icon-btn" aria-label={n > 0 ? t("tm_notifUnread", { n }) : t("tm_notif")} aria-expanded={open} title={t("tm_notif")} onClick={() => setOpen((v) => !v)} style={{ position: "relative" }}>
        <BellRing size={18} />{n > 0 && <span className="nav-badge" style={{ position: "absolute", top: 2, insetInlineEnd: 2 }} aria-hidden>{n > 9 ? "9+" : n}</span>}
      </button>
      {open && (
        <div className="menu" role="region" aria-label={t("tm_notif")} style={{ insetInlineEnd: 0 }}>
          <div className="row" style={{ justifyContent: "space-between", padding: "6px 12px" }}>
            <strong>{t("tm_notif")}</strong>
            <button type="button" className="btn sm ghost" onClick={readAll} disabled={n === 0}><Check size={14} aria-hidden /> {t("tm_markAll")}</button>
          </div>
          <div className="notif-list">
            {!list.loaded && !list.error && <p className="meta small" style={{ padding: 12 }}>…</p>}
            {list.loaded && list.data!.length === 0 && <p className="meta small" style={{ padding: 12 }}>{t("tm_notifNone")}</p>}
            {(list.data ?? []).map((i) => {
              const when = new Date(i.createdAt).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" });
              const cls = `notif-item${i.readAt ? "" : " unread"}`;
              return i.link
                ? <Link key={i.id} className={cls} href={i.link} onClick={() => { setOpen(false); if (!i.readAt) void readOne(i.id); }}>{i.title}<br /><span className="meta small">{when}</span></Link>
                : <div key={i.id} className={cls}>{i.title}<br /><span className="meta small">{when}</span></div>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}
