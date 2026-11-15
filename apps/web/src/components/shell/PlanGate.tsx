"use client";
import { Lock, PauseCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { SECTIONS, classifyPage, type SectionId } from "@routenorth/shared";
import { apiSend } from "@/lib/api";
import { saveSession } from "@/lib/session";

/** Shown in place of a page the company's plan does not include. The server refuses the data too; this is the friendly side of that. */
export function NotIncluded({ pathname }: { pathname: string }) {
  const where = classifyPage(pathname);
  const label = SECTIONS.find((s) => s.id === (where as SectionId))?.label;
  return (
    <div className="state" role="status" style={{ marginTop: "12vh" }}>
      <Lock size={36} aria-hidden />
      <h2>{label ? `${label} is not part of your plan` : "This is not part of your plan"}</h2>
      <p>Your company's RouteNorth plan does not include this section. Everything else you have is still here. To add it, ask your account manager at RouteNorth.</p>
      <Link href="/support" className="btn alt">Contact RouteNorth</Link>
    </div>
  );
}

export function SuspendedState({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="state" role="alert">
        <PauseCircle size={36} aria-hidden />
        <h2>This account is paused</h2>
        <p>RouteNorth has paused access for your company. Your data is kept. Please contact RouteNorth support to get it switched back on.</p>
        <button type="button" className="btn alt" onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  );
}

/** Amber bar across the top while RouteNorth staff are looking at an account. It cannot be hidden, and ends the view when pressed. */
export function StaffViewBar({ info }: { info: { reason: string; expiresAt: string; by: string } }) {
  const left = () => Math.max(0, Math.round((new Date(info.expiresAt).getTime() - Date.now()) / 60000));
  const [mins, setMins] = useState(left);
  useEffect(() => {
    document.body.setAttribute("data-staff-view", "");
    const id = setInterval(() => setMins(left()), 15_000);
    return () => { clearInterval(id); document.body.removeAttribute("data-staff-view"); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  function end() {
    void apiSend("POST", "/auth/logout").catch(() => {}).finally(() => { saveSession(null); window.close(); window.location.assign("/login"); });
  }
  return (
    <div className="staff-view-bar" role="status">
      <span>Staff view, read-only. {info.by} is looking at this account{mins > 0 ? ` (${mins} min left)` : ""}.</span>
      <button type="button" onClick={end}>End view</button>
    </div>
  );
}
