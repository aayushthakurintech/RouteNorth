"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "./i18n-context";

interface ToastItem { id: number; text: string; tone: "info" | "error"; undo?: () => void }
interface ToastApi {
  /** Show a message. With `undo`, the toast offers an Undo button for a few seconds. */
  toast: (text: string, opts?: { tone?: "info" | "error"; undo?: () => void; ms?: number }) => void;
  /**
   * Delete with undo: `remove` runs after the toast expires unless the person presses Undo.
   * `hide` should take the item out of the list straight away and `restore` puts it back.
   */
  undoable: (text: string, opts: { hide: () => void; restore: () => void; commit: () => Promise<unknown> | void; ms?: number }) => void;
}

const Ctx = createContext<ToastApi>({ toast: () => {}, undoable: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const drop = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((l) => l.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback<ToastApi["toast"]>((text, opts = {}) => {
    const id = next.current++;
    setItems((l) => [...l.slice(-3), { id, text, tone: opts.tone ?? "info", undo: opts.undo }]);
    timers.current.set(id, setTimeout(() => drop(id), opts.ms ?? (opts.undo ? 7000 : 4000)));
  }, [drop]);

  const undoable = useCallback<ToastApi["undoable"]>((text, o) => {
    o.hide();
    let undone = false;
    const ms = o.ms ?? 6000;
    const commit = setTimeout(() => { if (!undone) void Promise.resolve(o.commit()).catch(() => { o.restore(); toast(t("loadError"), { tone: "error" }); }); }, ms);
    toast(text, { ms, undo: () => { undone = true; clearTimeout(commit); o.restore(); toast(t("undone")); } });
  }, [t, toast]);

  // Leaving the page commits pending deletes rather than dropping them.
  useEffect(() => () => { for (const v of timers.current.values()) clearTimeout(v); }, []);

  return (
    <Ctx.Provider value={{ toast, undoable }}>
      {children}
      <div className="toasts" role="region" aria-live="polite" aria-label="Notifications">
        {items.map((i) => (
          <div key={i.id} className={`toast ${i.tone}`} role={i.tone === "error" ? "alert" : "status"}>
            <span>{i.text}</span>
            {i.undo && <button type="button" onClick={() => { i.undo?.(); drop(i.id); }}>{t("undo")}</button>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
