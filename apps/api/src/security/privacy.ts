/**
 * "Track only during shifts": a SQL condition that is true when a position should stay private. A position is private when its
 * vehicle was assigned to at least one driver that day (by a route) and none of those drivers had a shift open at that moment.
 * Vehicles with no assigned driver are not affected. `time` and `device` are SQL expressions for the position's time and device id.
 */
export function offShiftSql(time: string, device: string): string {
  const day = `(${time} AT TIME ZONE coalesce((SELECT timezone FROM organizations LIMIT 1), 'UTC'))::date`;
  const assigned = `SELECT 1 FROM devices pd JOIN routes pr ON pr.vehicle_id = pd.vehicle_id
                    WHERE pd.id = ${device} AND pr.driver_id IS NOT NULL AND pr.status <> 'cancelled' AND pr.route_date = ${day}`;
  const onShift = `SELECT 1 FROM devices sd JOIN routes sr ON sr.vehicle_id = sd.vehicle_id JOIN shifts ss ON ss.driver_id = sr.driver_id
                   WHERE sd.id = ${device} AND sr.status <> 'cancelled' AND sr.route_date = ${day}
                     AND ss.started_at <= ${time} AND coalesce(ss.ended_at, now()) >= ${time}`;
  return `(EXISTS (${assigned}) AND NOT EXISTS (${onShift}))`;
}
