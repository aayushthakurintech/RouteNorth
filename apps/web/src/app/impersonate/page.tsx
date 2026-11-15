"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { saveStaffView } from "@/lib/session";

/**
 * Landing for a staff "view as client". The token arrives in the URL fragment (never sent to any server or written to logs),
 * is kept for this tab only, and the fragment is removed straight away.
 */
export default function ImpersonatePage() {
  const router = useRouter();
  const [bad, setBad] = useState(false);
  useEffect(() => {
    const p = new URLSearchParams(window.location.hash.slice(1));
    const token = p.get("t"); const role = p.get("r");
    history.replaceState(null, "", window.location.pathname);
    if (!token || !role) { setBad(true); return; }
    saveStaffView({ token, role, locale: p.get("l") === "fr" ? "fr" : "en" });
    router.replace("/live");
  }, [router]);
  return <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}><p role={bad ? "alert" : "status"}>{bad ? "This link is not valid. Open the view again from the console." : "Opening the client's view…"}</p></main>;
}
