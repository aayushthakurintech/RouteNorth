"use client";
import { Plus, Route as RouteIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { MessageKey } from "@routenorth/shared";
import { EmptyState, ErrorState, Modal, PageHead, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { todayLocal } from "@/lib/format";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import type { RouteDetail, RouteSummary } from "@/lib/routes";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

export default function RoutesPage() {
  const { t } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const router = useRouter();
  const [date, setDate] = useState(todayLocal());
  const routes = useApi<RouteSummary[]>(`/routes?date=${date}`, { intervalMs: 15_000 });
  const vehicles = useApi<{ id: string; name: string }[]>("/vehicles");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [vehicleId, setVehicleId] = useState("");

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const route = await apiSend<RouteDetail>("POST", "/routes", { name, date, vehicleId: vehicleId || undefined, stops: [] });
      router.push(`/routes/${route.id}`);
    } catch {
      toast(t("saveFailed"), { tone: "error" });
    }
  }

  const list = routes.data ?? [];
  return (
    <div className="content">
      <PageHead
        title={t("routes")}
        actions={can("routes.write") && <button type="button" className="btn" onClick={() => setCreating(true)}><Plus size={16} aria-hidden />{t("newRoute")}</button>}
      />
      <label className="field" style={{ maxWidth: 220 }}>{t("date")}
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
      </label>

      {!routes.loaded && !routes.error && <SkeletonList rows={4} h={72} />}
      {routes.error && !routes.loaded && <ErrorState error={routes.error} onRetry={routes.reload} />}
      {routes.loaded && list.length === 0 && (
        <EmptyState
          icon={<RouteIcon size={36} aria-hidden />} title={t("noRoutes")}
          action={can("routes.write") ? <button type="button" className="btn" onClick={() => setCreating(true)}>{t("newRoute")}</button> : undefined}
        />
      )}
      {list.length > 0 && (
        <ul className="cards fade-in">
          {list.map((r) => (
            <li key={r.id}>
              <Link href={`/routes/${r.id}`} className="card-link">
                <strong>{r.name}</strong>
                <span className="meta">
                  {t(`route_${r.status}` as MessageKey)} · {r.finishedCount}/{r.stopCount} {t("stopsProgress")} ·{" "}
                  {vehicles.data?.find((v) => v.id === r.vehicleId)?.name ?? t("noVehicle")}
                </span>
                <progress max={Math.max(1, r.stopCount)} value={r.finishedCount} aria-label={t("stopsProgress")} />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title={t("newRoute")} actions={<><button type="button" className="btn alt" onClick={() => setCreating(false)}>{t("cancel")}</button><button type="submit" form="new-route" className="btn">{t("create")}</button></>}>
        <form id="new-route" className="stack" onSubmit={create}>
          <label className="field">{t("routeName")}
            <input required maxLength={200} name="routeName" autoComplete="off" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">{t("vehicle")}
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">{t("noVehicle")}</option>
              {(vehicles.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
        </form>
      </Modal>
    </div>
  );
}
