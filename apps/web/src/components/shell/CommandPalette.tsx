"use client";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MessageKey } from "@routenorth/shared";
import { apiGet } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";

export interface Command {
  id: string;
  label: string;
  /** A message key (translated) such as "actions", "jumpTo" or "group_route". */
  group: MessageKey;
  hint?: string;
  icon?: ReactNode;
  keywords?: string;
  run: () => void;
}

interface Hit { type: "vehicle" | "driver" | "route" | "stop" | "customer"; id: string; title: string; subtitle: string | null; href: string }

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Ctrl/Cmd+K: jump to any page, run an action, or search vehicles, drivers, routes and stops. */
export function CommandPalette({ open, onClose, commands, onNavigate }: { open: boolean; onClose: () => void; commands: Command[]; onNavigate: (href: string, label: string) => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState("");
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { d.showModal(); setQ(""); setHits([]); setSearched(""); setSel(0); }
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 1) { setHits([]); setSearched(""); return; }
    const id = setTimeout(() => {
      apiGet<Hit[]>(`/search?q=${encodeURIComponent(text)}`).then((h) => { setHits(h); setSearched(text); }).catch(() => { setHits([]); setSearched(text); });
    }, 180);
    return () => clearTimeout(id);
  }, [q]);

  const rows = useMemo(() => {
    const needle = fold(q.trim());
    const local = commands.filter((c) => !needle || fold(`${c.label} ${c.keywords ?? ""}`).includes(needle));
    const remote: Command[] = hits.map((h) => ({
      id: `hit:${h.type}:${h.id}`, label: h.title, hint: h.subtitle ?? undefined, group: `group_${h.type}` as MessageKey,
      run: () => onNavigate(h.href, h.title),
    }));
    return [...local, ...remote];
  }, [q, commands, hits, onNavigate]);

  useEffect(() => { setSel(0); }, [q, hits]);
  useEffect(() => { document.getElementById(`cmd-${sel}`)?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const run = (c: Command | undefined) => { if (!c) return; onClose(); c.run(); };
  let lastGroup = "";
  const noMatch = rows.length === 0 && q.trim() && searched === q.trim();

  return (
    <dialog
      ref={ref} className="palette" aria-label={t("cmdPalette")} onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="palette-input">
        <Search size={18} aria-hidden />
        <input
          autoFocus role="combobox" aria-expanded aria-controls="cmd-list" aria-activedescendant={rows[sel] ? `cmd-${sel}` : undefined}
          aria-label={t("cmdPlaceholder")} placeholder={t("cmdPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(rows.length - 1, s + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            if (e.key === "Enter") { e.preventDefault(); run(rows[sel]); }
          }}
        />
        <span className="kbd">Esc</span>
      </div>
      <ul id="cmd-list" className="palette-list" role="listbox" aria-label={t("cmdPalette")}>
        {rows.map((c, i) => {
          const header = c.group !== lastGroup ? c.group : null;
          lastGroup = c.group;
          return (
            <li key={c.id} role="presentation">
              {header && <div className="palette-group" role="presentation">{t(header)}</div>}
              <div id={`cmd-${i}`} role="option" aria-selected={i === sel} className="palette-item" onMouseMove={() => setSel(i)} onClick={() => run(c)}>
                {c.icon}
                <span>{c.label}</span>
                {c.hint && <span className="sub">{c.hint}</span>}
              </div>
            </li>
          );
        })}
        {noMatch && <li className="state" style={{ padding: 24 }}>{t("searchNoResults", { q: q.trim() })}</li>}
      </ul>
      <div className="palette-foot"><span>{t("searchHint")}</span></div>
    </dialog>
  );
}
