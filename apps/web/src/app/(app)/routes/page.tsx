"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { MessageKey } from "@routenorth/shared";
import { LanguageToggle } from "@/components/LanguageToggle";
import { apiGet, apiSend, Unauthorized } from "@/lib/api";
import { todayLocal } from "@/lib/format";
import { useI18n } from "@/lib/i18n-context";
import type { RouteDetail, RouteSummary } from "@/lib/routes";

export default function RoutesPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [date, setDate] = useState(todayLocal());
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [vehicles, setVehicles] = useState<{ id: string; name: string }[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [name, setName] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [formError, setFormError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, v] = await Promise.all([
        apiGet<RouteSummary[]>(`/routes?date=${date}`),
        apiGet<{ id: string; name: string }[]>("/vehicles"),
      ]);
      setRoutes(r); setVehicles(v); setState("ready");
    } catch (e) {
      if (e instanceof Unauthorized) router.replace("/login"); else setState("error");
    }
  }, [date, router]);

  useEffect(() => { setState("loading"); load(); const i = setInterval(load, 15_000); return () => clearInterval(i); }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setFormError(false);
    try {
      const route = await apiSend<RouteDetail>("POST", "/routes", { name, date, vehicleId: vehicleId || undefined, stops: [] });
      router.push(`/routes/${route.id}`);
    } catch (err) {
      if (err instanceof Unauthorized) router.replace("/login"); else setFormError(true);
    }
  }

  return (
    <main className="page">
      <header className="row">
        <Link href="/" className="link">← {t("back")}</Link>
        <LanguageToggle />
      </header>
      <h1>{t("routes")}</h1>
      <label className="field">{t("date")}
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
      </label>

      {state === "loading" && <p className="empty">{t("loading")}</p>}
      {state === "error" && <p className="error" role="alert">{t("loadFailed")}</p>}
      {state === "ready" && (routes.length === 0 ? <p className="empty">{t("noRoutes")}</p> : (
        <ul className="cards">
          {routes.map((r) => (
            <li key={r.id}>
              <Link href={`/routes/${r.id}`} className="card-link">
                <strong>{r.name}</strong>
                <span className="meta">
                  {t(`route_${r.status}` as MessageKey)} · {r.finishedCount}/{r.stopCount} {t("stopsProgress")} ·{" "}
                  {vehicles.find((v) => v.id === r.vehicleId)?.name ?? t("noVehicle")}
                </span>
                <progress max={Math.max(1, r.stopCount)} value={r.finishedCount} aria-label={t("stopsProgress")} />
              </Link>
            </li>
          ))}
        </ul>
      ))}

      <h2>{t("newRoute")}</h2>
      <form className="stack" onSubmit={create}>
        <label className="field">{t("routeName")}
          <input required maxLength={200} name="routeName" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">{t("vehicle")}
          <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
            <option value="">{t("noVehicle")}</option>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        {formError && <p className="error" role="alert">{t("saveFailed")}</p>}
        <button type="submit" className="btn">{t("create")}</button>
      </form>
    </main>
  );
}
