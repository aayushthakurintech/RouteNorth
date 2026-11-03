"use client";
import { Check, Circle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import { Modal } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useApi } from "@/lib/use-api";
import { RELEASE_NOTES } from "@/lib/whats-new";

interface Step { id: string; label: MessageKey; href?: string; done: boolean }

/** "Getting started" checklist for owners and admins. Steps tick themselves as the account fills up. */
export function SetupChecklist({ onTour }: { onTour: () => void }) {
  const { t } = useI18n();
  const { can, prefs, setPrefs } = useMe();
  const allowed = can("settings.manage") && !prefs.onboarding?.hidden;
  const vehicles = useApi<unknown[]>(allowed ? "/vehicles" : null);
  const drivers = useApi<unknown[]>(allowed && can("users.view") ? "/users?role=driver" : null);
  const today = new Date().toISOString().slice(0, 10);
  const routes = useApi<unknown[]>(allowed ? `/routes?date=${today}` : null);
  if (!allowed || !vehicles.loaded) return null;
  const seen = prefs.onboarding?.steps ?? [];
  const steps: Step[] = [
    { id: "vehicle", label: "setupVehicle", href: "/settings", done: (vehicles.data?.length ?? 0) > 0 },
    { id: "driver", label: "setupDriver", href: "/settings/users", done: (drivers.data?.length ?? 0) > 0 },
    { id: "route", label: "setupRoute", href: "/routes", done: (routes.data?.length ?? 0) > 0 },
    { id: "map", label: "setupMap", href: "/", done: seen.includes("map") },
    { id: "tour", label: "setupTour", done: !!prefs.onboarding?.tourDone },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <section className="setup-card" aria-label={t("setupChecklist")}>
      <strong>{t("setupChecklist")}</strong>
      <progress max={steps.length} value={done} aria-label={t("setupProgress", { done, total: steps.length })} />
      <span className="meta">{t("setupProgress", { done, total: steps.length })}</span>
      {steps.map((s) => {
        const icon = s.done ? <Check size={15} aria-hidden /> : <Circle size={15} aria-hidden />;
        return s.id === "tour" ? (
          <button key={s.id} type="button" className={`step ${s.done ? "done" : ""}`} onClick={onTour}>{icon}{t(s.label)}</button>
        ) : (
          <Link key={s.id} href={s.href ?? "/"} className={s.done ? "done" : ""}>{icon}{t(s.label)}</Link>
        );
      })}
      <button type="button" className="link" onClick={() => setPrefs({ onboarding: { ...prefs.onboarding, hidden: true } })}>{t("setupHide")}</button>
    </section>
  );
}

const TOUR: MessageKey[] = ["tourMap", "tourSearch", "tourRoutes", "tourReports", "tourDone"];

/** A short product tour: five cards, skippable, remembered once finished. */
export function ProductTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { prefs, setPrefs } = useMe();
  const [i, setI] = useState(0);
  if (!open) return null;
  const last = i === TOUR.length - 1;
  const finish = () => { setPrefs({ onboarding: { ...prefs.onboarding, tourDone: true } }); setI(0); onClose(); };
  return (
    <div className="tour" role="dialog" aria-label={t("tourTitle")}>
      <h2>{t("tourTitle")}</h2>
      <p>{t(TOUR[i]!)}</p>
      <div className="tour-dots" aria-hidden>{TOUR.map((_, k) => <i key={k} data-on={k === i} />)}</div>
      <div className="row">
        <button type="button" className="btn ghost sm" onClick={finish}>{t("skip")}</button>
        <span style={{ flex: 1 }} />
        {i > 0 && <button type="button" className="btn alt sm" onClick={() => setI(i - 1)}>{t("back2")}</button>}
        <button type="button" className="btn sm" onClick={() => (last ? finish() : setI(i + 1))}>{last ? t("finish") : t("next")}</button>
      </div>
    </div>
  );
}

export function WhatsNew({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { setPrefs } = useMe();
  const lang = locale === "fr" ? "fr" : "en";
  return (
    <Modal open={open} onClose={() => { setPrefs({ whatsNewSeen: RELEASE_NOTES[0]?.id }); onClose(); }} title={t("whatsNew")}>
      {RELEASE_NOTES.length === 0 ? <p>{t("whatsNewEmpty")}</p> : RELEASE_NOTES.map((n) => (
        <article key={n.id}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{n.title[lang]}</h3>
          <p className="meta" style={{ margin: "2px 0 4px" }}>{n.date}</p>
          <p style={{ margin: 0 }}>{n.body[lang]}</p>
        </article>
      ))}
    </Modal>
  );
}

const SHORTCUTS: { keys: string[]; label: MessageKey }[] = [
  { keys: ["Ctrl", "K"], label: "shortcutSearch" }, { keys: ["/"], label: "shortcutSearch" },
  { keys: ["g", "l"], label: "shortcutGoLive" }, { keys: ["g", "r"], label: "shortcutGoRoutes" }, { keys: ["g", "p"], label: "shortcutGoReports" },
  { keys: ["t"], label: "shortcutTheme" }, { keys: ["["], label: "shortcutNav" }, { keys: ["?"], label: "shortcutHelp" }, { keys: ["Esc"], label: "shortcutEsc" },
];

export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal open={open} onClose={onClose} title={t("shortcuts")}>
      <p className="meta" style={{ margin: 0 }}>{t("shortcutsHint")}</p>
      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 16px", margin: 0 }}>
        {SHORTCUTS.map((s, i) => (
          <div key={i} style={{ display: "contents" }}>
            <dt>{s.keys.map((k, j) => <span key={j}><span className="kbd">{k}</span>{j < s.keys.length - 1 ? " " : ""}</span>)}</dt>
            <dd style={{ margin: 0 }}>{t(s.label)}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
