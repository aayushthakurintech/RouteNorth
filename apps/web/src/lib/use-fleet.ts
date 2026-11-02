"use client";
import { useEffect, useRef, useState } from "react";
import { applyPosition, initFleet, refreshStatuses, type Fleet, type LiveVehicle, type PositionMessage } from "./fleet";
import { API_URL, WS_URL } from "./session";

export interface FleetFeed {
  fleet: Fleet;
  connected: boolean;
  /** true when the token was rejected (expired or invalid) */
  unauthorized: boolean;
  loaded: boolean;
}

/** Loads the current fleet, then keeps it live over a WebSocket that reconnects on drop. */
export function useFleet(token: string | null): FleetFeed {
  const [fleet, setFleet] = useState<Fleet>({});
  const [connected, setConnected] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const retry = useRef(1000);
  const unauthorizedRef = useRef(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      const res = await fetch(`${API_URL}/vehicles/live`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { unauthorizedRef.current = true; setUnauthorized(true); return false; }
      if (!res.ok) return false;
      if (!cancelled) { setFleet(initFleet((await res.json()) as LiveVehicle[])); setLoaded(true); }
      return true;
    };

    const open = () => {
      ws = new WebSocket(`${WS_URL}/live?token=${encodeURIComponent(token)}`);
      ws.onopen = () => { retry.current = 1000; setConnected(true); };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as PositionMessage;
        setFleet((f) => applyPosition(f, msg));
      };
      ws.onclose = (ev) => {
        setConnected(false);
        if (ev.code === 4401) { setUnauthorized(true); return; }
        if (cancelled) return;
        timer = setTimeout(async () => {
          // Re-sync after a gap so positions missed while disconnected are not lost.
          await load().catch(() => false);
          if (!cancelled) open();
        }, retry.current);
        retry.current = Math.min(retry.current * 2, 15000);
      };
    };

    const start = () => {
      load()
        .then((ok) => { if (ok && !cancelled) open(); else if (!cancelled && !unauthorizedRef.current) timer = setTimeout(start, 5000); })
        .catch(() => { if (!cancelled) timer = setTimeout(start, 5000); });
    };
    start();
    const tick = setInterval(() => setFleet((f) => refreshStatuses(f)), 30_000);

    return () => { cancelled = true; clearTimeout(timer); clearInterval(tick); ws?.close(); };
  }, [token]);

  return { fleet, connected, unauthorized, loaded };
}
