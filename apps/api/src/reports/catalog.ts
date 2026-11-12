import type { ReportSpec } from "./datasets.js";

/**
 * The 56 ready-made reports of the Owner Portal spec (pages 14 to 18), by their spec ids. Each one is a report spec on a dataset in
 * portal-datasets.ts, so it runs, exports, compares to the previous period, drills down, saves as a copy, shares and schedules through
 * exactly the same code as a report built by hand.
 *
 * `status` is honest: "full" means the report answers the question in the spec with the columns and chart listed there. "partial" means
 * something is missing or drawn differently, and `note` says what, in plain words.
 */
export type Group = "vehicles" | "drivers" | "pay" | "trips" | "finance" | "safety" | "customers";
export interface CatalogReport {
  id: string; group: Group; name: string; question: string; spec: ReportSpec;
  /** Chart the spec asks for. When the screen draws something simpler, `note` says so. */
  specChart: string;
  /** Open the rows behind a grouped row: the dataset to open and which result column matches which column of it. */
  drill?: { dataset: string; map: Record<string, string> };
  /** The date range does not apply to this report (it looks at a whole life, a month or the future), so "compare" is hidden. */
  fixedRange?: boolean;
  /** Columns the person can group by on the screen. */
  groupBy?: string[];
  status: "full" | "partial";
  note?: string;
}

const m = (...keys: string[]) => keys.map((key) => ({ key }));
const agg = (key: string, a: "sum" | "avg" | "count" | "min" | "max") => ({ key, agg: a });
const COMPLETED = { key: "status", op: "eq" as const, value: "completed" };

export const GROUP_NAMES: Record<Group, string> = { vehicles: "Vehicle reports", drivers: "Driver reports", pay: "Pay rate and payout reports", trips: "Trip and operations reports", finance: "Finance reports", safety: "Safety, compliance, and audit reports", customers: "Customer and growth reports" };

export const CATALOG: CatalogReport[] = [
  // ---- Vehicle reports ----
  { id: "V1", group: "vehicles", name: "Fleet summary", question: "What do I own and what state is it in?", specChart: "Status donut", status: "full", fixedRange: true,
    spec: { dataset: "vehicles", range: { preset: "last30" }, columns: m("vehicle", "status", "ageYears", "odometerKm", "driver"), chart: { type: "donut", x: "status", y: ["count"] } } },
  { id: "V2", group: "vehicles", name: "Vehicle profit and loss", question: "Which cars make or lose money?", specChart: "Bar by car", status: "full", drill: { dataset: "trips", map: { vehicle: "vehicle" } },
    spec: { dataset: "carMoney", range: { preset: "last30" }, columns: m("vehicle", "revenue", "fuel", "repairs", "insurance", "finance", "driverPay", "otherCosts", "profit"), sort: { key: "profit", dir: "asc" }, chart: { type: "bar", x: "vehicle", y: ["profit"] } } },
  { id: "V3", group: "vehicles", name: "Total cost of ownership", question: "What does each car really cost?", specChart: "Stacked bar", status: "full", fixedRange: true,
    spec: { dataset: "carLifetime", range: { preset: "last30" }, columns: m("vehicle", "purchasePrice", "financeCost", "fuel", "repairs", "insurance", "otherRunning", "totalCost", "km", "costPerKm"), sort: { key: "totalCost", dir: "desc" }, chart: { type: "stacked", x: "vehicle", y: ["purchasePrice", "financeCost", "fuel", "repairs", "insurance", "otherRunning"] } },
    note: "Looks at each car's whole life, so the date range does not change it. Cost per km uses kilometres from recorded trips." },
  { id: "V4", group: "vehicles", name: "Utilization", question: "Which cars sit idle?", specChart: "Heat map by day", status: "partial",
    spec: { dataset: "vehicleDays", range: { preset: "last30" }, groupBy: ["vehicle"], columns: [agg("movingH", "sum"), agg("idleH", "sum"), agg("engineH", "sum")], calc: [{ key: "utilizationPct", label: "Moving share of a working day (%)", formula: "movingH * 100 / (count * 8)" }], sort: { key: "movingH", dir: "asc" }, pivot: { row: "vehicle", col: "date", value: "movingH", agg: "sum" }, chart: { type: "heat" } },
    note: "Hours come from GPS tracking. A working day is counted as 8 hours. Idle days are shown through the heat map (empty squares) rather than a separate column." },
  { id: "V5", group: "vehicles", name: "Maintenance history", question: "What was done and when?", specChart: "Timeline", status: "partial", drill: undefined,
    spec: { dataset: "repairs", range: { preset: "last90" }, columns: m("date", "vehicle", "kind", "task", "shop", "total", "odometerKm"), sort: { key: "date", dir: "desc" }, chart: { type: "bar", x: "date", y: ["total"], bucket: "month" } },
    note: "Shown as cost by month, not a drawn timeline." },
  { id: "V6", group: "vehicles", name: "Service due", question: "What is coming up?", specChart: "Table with flags", status: "full", fixedRange: true,
    spec: { dataset: "vehicles", range: { preset: "last30" }, columns: m("vehicle", "nextService", "daysToService", "serviceState", "odometerKm"), sort: { key: "daysToService", dir: "asc" }, chart: { type: "table" } } },
  { id: "V7", group: "vehicles", name: "Fuel and energy", question: "How much fuel and what economy?", specChart: "Line over time", status: "full",
    spec: { dataset: "fuelLogs", range: { preset: "last30" }, columns: m("date", "vehicle", "station", "amount", "cost", "kmPerUnit"), sort: { key: "date", dir: "asc" }, chart: { type: "line", x: "date", y: ["cost"] } } },
  { id: "V8", group: "vehicles", name: "Repair and downtime", question: "How long and how costly are repairs?", specChart: "Bar", status: "full",
    spec: { dataset: "repairs", range: { preset: "last90" }, filters: [{ key: "kind", op: "eq", value: "repair" }], groupBy: ["vehicle", "task"], columns: [agg("downtimeDays", "sum"), agg("total", "sum")], sort: { key: "count", dir: "desc" }, chart: { type: "bar", x: "vehicle", y: ["downtimeDays"] } },
    note: "Rows with a count above 1 are repeat issues on the same car." },
  { id: "V9", group: "vehicles", name: "Document expiry (cars)", question: "What expires soon?", specChart: "Table with flags", status: "full", fixedRange: true,
    spec: { dataset: "documents", range: { preset: "last30" }, filters: [{ key: "ownerKind", op: "eq", value: "Car" }, { key: "status", op: "ne", value: "no expiry" }], columns: m("subject", "kind", "expiresOn", "daysLeft", "status"), sort: { key: "daysLeft", dir: "asc" }, chart: { type: "table" } } },
  { id: "V10", group: "vehicles", name: "Incidents and claims", question: "What went wrong?", specChart: "Bar by month", status: "full",
    spec: { dataset: "incidentRegister", range: { preset: "last12months" }, columns: m("date", "vehicle", "driver", "kind", "severity", "repairCost", "claimStatus"), sort: { key: "date", dir: "desc" }, chart: { type: "bar", x: "date", y: ["count"], bucket: "month" } } },
  { id: "V11", group: "vehicles", name: "Depreciation and value", question: "What is each car worth now?", specChart: "Line", status: "partial", fixedRange: true,
    spec: { dataset: "carLifetime", range: { preset: "last30" }, columns: m("vehicle", "purchaseDate", "ageYears", "purchasePrice", "currentValue", "valueLostPct"), sort: { key: "valueLostPct", dir: "desc" }, chart: { type: "bar", x: "vehicle", y: ["purchasePrice", "currentValue"] } },
    note: "Shows purchase price against the current value you entered as bars. The loan balance is not tracked, so it is not shown." },
  { id: "V12", group: "vehicles", name: "Keep, repair, or sell", question: "Which cars should go?", specChart: "Scatter", status: "full", fixedRange: true,
    spec: { dataset: "carLifetime", range: { preset: "last30" }, columns: m("vehicle", "ageYears", "currentValue", "repairs12m", "profit12m", "keepScore", "advice"), sort: { key: "keepScore", dir: "desc" }, chart: { type: "scatter", x: "ageYears", y: ["repairs12m"] } },
    note: "The score is the same one shown on each car's Financials tab: 60% repair cost against value, 25% age, 15% a loss over 12 months." },

  // ---- Driver reports ----
  { id: "D1", group: "drivers", name: "Driver roster", question: "Who works for me?", specChart: "Status donut", status: "full", fixedRange: true, drill: undefined,
    spec: { dataset: "drivers", range: { preset: "last30" }, columns: m("driver", "status", "vehicle", "startDate", "rateCard"), sort: { key: "driver", dir: "asc" }, chart: { type: "donut", x: "status", y: ["count"] } } },
  { id: "D2", group: "drivers", name: "Driver scorecard", question: "Who performs best?", specChart: "Radar and table", status: "partial", fixedRange: true, drill: { dataset: "trips", map: { driver: "driver" } },
    spec: { dataset: "drivers", range: { preset: "last30" }, columns: m("driver", "score", "onTimePct", "rating", "safety"), sort: { key: "score", dir: "desc" }, chart: { type: "bar", x: "driver", y: ["score"] } },
    note: "Drawn as bars, not a radar. Acceptance rate is not recorded yet, so it is not in the table." },
  { id: "D3", group: "drivers", name: "Driver profit", question: "Which drivers earn me money?", specChart: "Bar", status: "full", drill: { dataset: "trips", map: { driver: "driver" } },
    spec: { dataset: "driverProfit", range: { preset: "last30" }, columns: m("driver", "trips", "revenue", "driverPay", "carCost", "profit", "marginPct"), sort: { key: "profit", dir: "desc" }, chart: { type: "bar", x: "driver", y: ["profit"] } },
    note: "Car running cost covers fuel, repairs and the rest of the car's per-km cost, as set on the trip." },
  { id: "D4", group: "drivers", name: "Hours and overtime", question: "Who works how long?", specChart: "Stacked bar", status: "partial", drill: { dataset: "shifts", map: { driver: "driver" } },
    spec: { dataset: "shifts", range: { preset: "last30" }, groupBy: ["driver"], columns: [agg("hours", "sum"), agg("overtimeHours", "sum")], sort: { key: "hours", dir: "desc" }, chart: { type: "stacked", x: "driver", y: ["hours", "overtimeHours"] } },
    note: "Break time is not recorded separately, so it is not a column." },
  { id: "D5", group: "drivers", name: "Attendance", question: "Who shows up?", specChart: "Calendar heat map", status: "partial", drill: { dataset: "attendance", map: { driver: "driver" } },
    spec: { dataset: "attendance", range: { preset: "last30" }, groupBy: ["driver"], columns: [agg("jobs", "sum"), agg("hours", "sum"), agg("lateMinutes", "max"), agg("noShow", "sum")], sort: { key: "noShow", dir: "desc" }, pivot: { row: "driver", col: "date", value: "hours", agg: "sum" }, chart: { type: "heat" } },
    note: "There is no shift schedule yet, so jobs given stand in for scheduled work: no-show means jobs given and no shift that day; late start is the first shift against the first job window." },
  { id: "D6", group: "drivers", name: "Safety events", question: "Who drives risky?", specChart: "Bar", status: "full", drill: { dataset: "driverEvents", map: { driver: "driver", kind: "kind" } },
    spec: { dataset: "driverEvents", range: { preset: "last30" }, groupBy: ["driver", "kind"], columns: [agg("severity", "avg")], sort: { key: "count", dir: "desc" }, chart: { type: "bar", x: "driver", y: ["count"] } } },
  { id: "D7", group: "drivers", name: "Ratings and complaints", question: "How do customers rate drivers?", specChart: "Line", status: "full", drill: undefined,
    spec: { dataset: "ratings", range: { preset: "last30" }, columns: m("date", "source", "driver", "customer", "rating", "comment", "complaints"), sort: { key: "date", dir: "desc" }, chart: { type: "line", x: "date", y: ["rating"] } },
    note: "Complaint resolution is not tracked, so only the complaint text is shown." },
  { id: "D8", group: "drivers", name: "Document expiry (drivers)", question: "Whose papers expire?", specChart: "Table with flags", status: "full", fixedRange: true,
    spec: { dataset: "documents", range: { preset: "last30" }, filters: [{ key: "ownerKind", op: "eq", value: "Driver" }, { key: "status", op: "ne", value: "no expiry" }], columns: m("subject", "kind", "expiresOn", "daysLeft", "status"), sort: { key: "daysLeft", dir: "asc" }, chart: { type: "table" } } },
  { id: "D9", group: "drivers", name: "Onboarding funnel", question: "Where do new drivers drop out?", specChart: "Funnel", status: "full", fixedRange: true,
    spec: { dataset: "onboarding", range: { preset: "last30" }, filters: [{ key: "status", op: "eq", value: "approved" }], groupBy: ["step"], columns: [agg("daysToDecide", "avg")], sort: { key: "count", dir: "desc" }, chart: { type: "funnel", x: "step", y: ["count"] } },
    note: "Counts drivers who have cleared each step. A step with fewer than the one before it is where people drop out." },
  { id: "D10", group: "drivers", name: "Retention and turnover", question: "Who is leaving?", specChart: "Line", status: "partial", fixedRange: true,
    spec: { dataset: "driverTenure", range: { preset: "last30" }, columns: m("driver", "status", "startDate", "endDate", "tenureDays", "reason"), sort: { key: "startDate", dir: "desc" }, chart: { type: "bar", x: "startMonth", y: ["count"] } },
    note: "The chart shows hires per month. Leavers and their reasons are in the table." },
  { id: "D11", group: "drivers", name: "Training and compliance", question: "Is everyone trained?", specChart: "Progress bars", status: "full", fixedRange: true,
    spec: { dataset: "training", range: { preset: "last30" }, groupBy: ["course", "status"], columns: [], sort: { key: "course", dir: "asc" }, chart: { type: "stacked", x: "course", series: "status", y: ["count"] } } },
  { id: "D12", group: "drivers", name: "Driver comparison", question: "How does A compare to B?", specChart: "Side-by-side bars", status: "full", fixedRange: true,
    spec: { dataset: "drivers", range: { preset: "last30" }, columns: m("driver", "score", "onTimePct", "rating", "safety", "trips30", "revenue30", "earnings30"), sort: { key: "driver", dir: "asc" }, chart: { type: "bar", x: "driver", y: ["score", "onTimePct", "rating"] } },
    note: "Choose the drivers with a filter on the Driver column (is one of)." },

  // ---- Pay rate and payout reports ----
  { id: "P1", group: "pay", name: "Payout statement", question: "What does each driver get paid?", specChart: "Table, PDF per driver", status: "partial", drill: { dataset: "payLines", map: { driver: "driver" } },
    spec: { dataset: "payouts", range: { preset: "last30" }, columns: m("from", "to", "driver", "earnings", "bonuses", "tips", "deductions", "net", "status"), sort: { key: "to", dir: "desc" }, chart: { type: "table" } },
    note: "Each driver's full statement opens from Pay rates. A PDF per driver is not built; the export is one PDF for the whole table." },
  { id: "P2", group: "pay", name: "Payroll export", question: "What goes to payroll or accounting?", specChart: "Table", status: "full",
    spec: { dataset: "payouts", range: { preset: "last30" }, filters: [{ key: "status", op: "in", value: ["approved", "sent", "paid"] }], columns: m("from", "to", "driver", "employment", "earnings", "bonuses", "tips", "net", "method", "taxForm"), calc: [{ key: "gross", label: "Gross (earnings + bonuses + tips)", formula: "earnings + bonuses + tips" }], sort: { key: "to", dir: "desc" }, chart: { type: "table" } },
    note: "Tax withholding is not calculated; the tax form column says whether the driver's form is on file." },
  { id: "P3", group: "pay", name: "Pay by rate card", question: "Which rate cards cost the most?", specChart: "Bar", status: "full", drill: { dataset: "trips", map: { rateCard: "rateCard" } },
    spec: { dataset: "trips", range: { preset: "last30" }, filters: [COMPLETED], groupBy: ["rateCard"], columns: [agg("driverPay", "sum")], calc: [{ key: "avgPerTrip", label: "Average per trip", formula: "driverPay / count" }], sort: { key: "driverPay", dir: "desc" }, chart: { type: "bar", x: "rateCard", y: ["driverPay"] } } },
  { id: "P4", group: "pay", name: "Pay vs revenue margin", question: "Is pay too high or too low?", specChart: "Line", status: "full", drill: { dataset: "trips", map: { date: "date" } },
    spec: { dataset: "trips", range: { preset: "last30" }, filters: [COMPLETED], groupBy: ["date"], columns: [agg("price", "sum"), agg("driverPay", "sum")], calc: [{ key: "payPct", label: "Pay as % of revenue", formula: "driverPay * 100 / price" }, { key: "marginAfterPay", label: "Left after pay", formula: "price - driverPay" }], sort: { key: "date", dir: "asc" }, chart: { type: "line", x: "date", y: ["payPct"] } } },
  { id: "P5", group: "pay", name: "Bonus and incentive cost", question: "What do bonuses cost and do they work?", specChart: "Stacked bar", status: "partial", drill: { dataset: "payLines", map: { label: "label" } },
    spec: { dataset: "payLines", range: { preset: "last90" }, filters: [{ key: "kind", op: "eq", value: "bonus" }], groupBy: ["label"], columns: [agg("amount", "sum")], sort: { key: "amount", dir: "desc" }, chart: { type: "bar", x: "label", y: ["amount"] } },
    note: "Shows what each bonus cost and how many times it was paid. Trips gained by a bonus cannot be measured, so that column is not shown." },
  { id: "P6", group: "pay", name: "Deductions and adjustments", question: "What was taken or changed?", specChart: "Bar", status: "full",
    spec: { dataset: "payLines", range: { preset: "last90" }, filters: [{ key: "kind", op: "in", value: ["deduction", "adjustment"] }], columns: m("date", "driver", "kind", "label", "amount", "reason", "changedBy"), sort: { key: "date", dir: "desc" }, chart: { type: "bar", x: "label", y: ["amount"] } } },
  { id: "P7", group: "pay", name: "Rate card change impact", question: "What did the last change do?", specChart: "Before-and-after bars", status: "full", drill: { dataset: "trips", map: { rateCard: "rateCard" } },
    spec: { dataset: "trips", range: { preset: "last90" }, filters: [COMPLETED], groupBy: ["rateCard"], columns: [agg("driverPay", "sum"), agg("margin", "sum")], calc: [{ key: "avgPay", label: "Average pay per trip", formula: "driverPay / count" }, { key: "avgMargin", label: "Average left per trip", formula: "margin / count" }], sort: { key: "rateCard", dir: "asc" }, chart: { type: "bar", x: "rateCard", y: ["avgPay", "avgMargin"] } },
    note: "Each version of a card is its own bar, so a change shows as the old version next to the new one." },
  { id: "P8", group: "pay", name: "Disputes and corrections", question: "Where do pay problems come from?", specChart: "Bar by reason", status: "partial",
    spec: { dataset: "disputes", range: { preset: "last90" }, columns: m("date", "driver", "line", "message", "status", "daysToFix"), sort: { key: "date", dir: "desc" }, chart: { type: "bar", x: "status", y: ["count"] } },
    note: "Questions are free text, so the chart groups by status instead of by reason." },

  // ---- Trip and operations reports ----
  { id: "T1", group: "trips", name: "Trip log", question: "What happened on every trip?", specChart: "Table", status: "full",
    spec: { dataset: "trips", range: { preset: "last7" }, columns: m("date", "driver", "vehicle", "customer", "km", "minutes", "price", "driverPay", "status"), sort: { key: "date", dir: "desc" }, chart: { type: "table" } } },
  { id: "T2", group: "trips", name: "On-time performance", question: "Are we on time?", specChart: "Line and bar", status: "full",
    spec: { dataset: "stops", range: { preset: "last30" }, groupBy: ["date"], columns: [agg("onTime", "avg"), agg("delayMin", "avg"), agg("failed", "sum")], sort: { key: "date", dir: "asc" }, chart: { type: "line", x: "date", y: ["onTime"] } },
    note: "Uses planned stops: the promised time window against the actual arrival." },
  { id: "T3", group: "trips", name: "Planned vs actual route", question: "Do drivers follow the plan?", specChart: "Bar", status: "full",
    spec: { dataset: "routes", range: { preset: "last30" }, columns: m("date", "route", "driver", "plannedKm", "actualKm", "kmOverPlanPct", "plannedMin", "actualMin"), sort: { key: "kmOverPlanPct", dir: "desc" }, chart: { type: "bar", x: "route", y: ["plannedKm", "actualKm"] } } },
  { id: "T4", group: "trips", name: "Demand by hour and zone", question: "Where and when is the work?", specChart: "Heat map and map", status: "partial",
    spec: { dataset: "trips", range: { preset: "last30" }, groupBy: ["zone", "weekday"], columns: [], sort: { key: "count", dir: "desc" }, pivot: { row: "weekday", col: "hour", value: "count", agg: "sum" }, chart: { type: "heat" } },
    note: "The heat map shows trips by day and hour. The table breaks them down by zone. No map is drawn." },
  { id: "T5", group: "trips", name: "Cancellations and failures", question: "Why do jobs fail?", specChart: "Bar by reason", status: "partial",
    spec: { dataset: "jobs", range: { preset: "last30" }, filters: [{ key: "status", op: "in", value: ["failed", "cancelled"] }], columns: m("date", "ref", "customer", "driver", "status", "reason"), sort: { key: "date", dir: "desc" }, chart: { type: "bar", x: "reason", y: ["count"] } },
    note: "The cost of a failed job is not recorded, so it is not shown." },
  { id: "T6", group: "trips", name: "Idle and wait time", question: "Where is time wasted?", specChart: "Bar and map", status: "partial",
    spec: { dataset: "vehicleDays", range: { preset: "last30" }, groupBy: ["vehicle"], columns: [agg("idleH", "sum"), agg("engineH", "sum")], calc: [{ key: "idleSharePct", label: "Idle share of engine time (%)", formula: "idleH * 100 / engineH" }], sort: { key: "idleH", dir: "desc" }, chart: { type: "bar", x: "vehicle", y: ["idleH"] } },
    note: "Idle time comes from GPS tracking. Waiting time at a customer is on the Trip log. No map is drawn." },
  { id: "T7", group: "trips", name: "Revenue per kilometre and per hour", question: "Which work pays best?", specChart: "Bar", status: "full", drill: { dataset: "trips", map: { route: "route" } },
    spec: { dataset: "trips", range: { preset: "last30" }, filters: [COMPLETED], groupBy: ["route"], columns: [agg("revenuePerKm", "avg"), agg("revenuePerHour", "avg"), agg("price", "sum")], sort: { key: "revenuePerKm", dir: "desc" }, chart: { type: "bar", x: "route", y: ["revenuePerKm"] } },
    groupBy: ["route", "zone", "customer", "driver", "vehicle"], note: "Averages are per trip. Group by zone to compare zones." },

  // ---- Finance reports ----
  { id: "F1", group: "finance", name: "Profit and loss", question: "Did I make money?", specChart: "Waterfall", status: "full",
    spec: { dataset: "profitLossLines", range: { preset: "last30" }, columns: m("line", "amount"), sort: { key: "step", dir: "asc" }, chart: { type: "waterfall", x: "line", y: ["amount"] } },
    note: "Same figures as the Profit and loss page and the dashboard." },
  { id: "F2", group: "finance", name: "Revenue breakdown", question: "Where does money come from?", specChart: "Treemap", status: "partial", drill: { dataset: "trips", map: { customer: "customer" } },
    spec: { dataset: "trips", range: { preset: "last30" }, filters: [COMPLETED], groupBy: ["customer"], columns: [agg("price", "sum")], sort: { key: "price", dir: "desc" }, chart: { type: "bar", x: "customer", y: ["price"] } },
    groupBy: ["customer", "route", "vehicle", "driver", "zone"], note: "Drawn as bars, not a treemap. Group by car, driver, route or zone with the group-by box." },
  { id: "F3", group: "finance", name: "Expense breakdown", question: "Where does money go?", specChart: "Stacked bar", status: "full", drill: { dataset: "costs", map: { month: "month", category: "category" } },
    spec: { dataset: "costs", range: { preset: "last12months" }, groupBy: ["month", "category"], columns: [agg("amount", "sum")], sort: { key: "month", dir: "asc" }, chart: { type: "stacked", x: "month", series: "category", y: ["amount"] } },
    note: "Includes driver pay and the accrued loan and lease cost, like the profit and loss. Individual expense lines are on the Expenses page." },
  { id: "F4", group: "finance", name: "Cash flow forecast", question: "Will I have enough cash?", specChart: "Line", status: "partial", fixedRange: true,
    spec: { dataset: "cashForecast", range: { preset: "last30" }, columns: m("week", "expectedIn", "expectedOut", "net", "balance"), sort: { key: "week", dir: "asc" }, chart: { type: "line", x: "week", y: ["balance"] } },
    note: "Shows expected in against expected out, not a bank balance. Running costs are an estimate from the last 90 days." },
  { id: "F5", group: "finance", name: "Accounts receivable", question: "Who owes me?", specChart: "Aging bars", status: "full", fixedRange: true,
    spec: { dataset: "invoices", range: { preset: "allTime" }, filters: [{ key: "status", op: "in", value: ["sent", "overdue"] }], groupBy: ["bucket"], columns: [agg("total", "sum")], sort: { key: "total", dir: "desc" }, chart: { type: "bar", x: "bucket", y: ["total"] } },
    drill: { dataset: "invoices", map: { bucket: "bucket" } } },
  { id: "F6", group: "finance", name: "Budget vs actual", question: "Am I on budget?", specChart: "Bullet bars", status: "partial", fixedRange: true,
    spec: { dataset: "budgetActual", range: { preset: "thisMonth" }, columns: m("category", "budget", "actual", "difference", "usedPct", "state"), sort: { key: "category", dir: "asc" }, chart: { type: "bar", x: "category", y: ["budget", "actual"] } },
    note: "Reports the month of the last date picked. Drawn as paired bars, not bullet bars." },
  { id: "F7", group: "finance", name: "Tax summary", question: "What tax do I owe or hold?", specChart: "Table", status: "full",
    spec: { dataset: "taxSummary", range: { preset: "thisYear" }, columns: m("month", "sales", "taxCollected", "spend", "taxPaid", "netOwed"), sort: { key: "month", dir: "asc" }, chart: { type: "table" } },
    note: "A summary for your accountant. It is not a tax filing." },
  { id: "F8", group: "finance", name: "Break-even", question: "How many trips pay my bills?", specChart: "Line", status: "full",
    spec: { dataset: "breakEven", range: { preset: "last90" }, columns: m("trips", "revenue", "profit", "fixedCosts", "marginPerTrip", "breakEvenTrips"), sort: { key: "trips", dir: "asc" }, chart: { type: "line", x: "trips", y: ["profit"] } },
    note: "Fixed costs are insurance and loan or lease. Left per trip is the price minus driver pay, fuel, repairs and other running costs, averaged over the dates picked." },

  // ---- Safety, compliance and audit ----
  { id: "C1", group: "safety", name: "Compliance status", question: "Is everything legal and current?", specChart: "Progress bars", status: "partial", fixedRange: true,
    spec: { dataset: "documents", range: { preset: "last30" }, groupBy: ["ownerKind", "status"], columns: [], sort: { key: "ownerKind", dir: "asc" }, chart: { type: "stacked", x: "ownerKind", series: "status", y: ["count"] } },
    drill: { dataset: "documents", map: { ownerKind: "ownerKind", status: "status" } }, note: "Covers documents that are expired, expiring or valid. Items that were never added cannot be counted as missing." },
  { id: "C2", group: "safety", name: "Inspection results", question: "Are cars passing checks?", specChart: "Bar", status: "full",
    spec: { dataset: "inspections", range: { preset: "last90" }, columns: m("date", "vehicle", "driver", "kind", "result", "failedItems", "signedOffOn"), sort: { key: "date", dir: "desc" }, chart: { type: "stacked", x: "date", series: "result", y: ["count"], bucket: "month" } } },
  { id: "C3", group: "safety", name: "Safety trends", question: "Is driving getting safer?", specChart: "Line", status: "full",
    spec: { dataset: "safetyMonthly", range: { preset: "last12months" }, columns: m("month", "kind", "events", "km", "per1000"), sort: { key: "month", dir: "asc" }, chart: { type: "line", x: "month", series: "kind", y: ["per1000"] } } },
  { id: "C4", group: "safety", name: "Incident register", question: "What incidents happened?", specChart: "Table", status: "full",
    spec: { dataset: "incidentRegister", range: { preset: "last12months" }, columns: m("date", "kind", "vehicle", "driver", "severity", "status", "repairCost", "followUp"), sort: { key: "date", dir: "desc" }, chart: { type: "table" } } },
  { id: "C5", group: "safety", name: "Audit log", question: "Who changed what?", specChart: "Table", status: "full",
    spec: { dataset: "auditLog", range: { preset: "last7" }, columns: m("time", "user", "action", "item", "oldValue", "newValue"), sort: { key: "time", dir: "desc" }, chart: { type: "table" } },
    note: "Needs permission to view the audit log. Values of sensitive fields such as bank details are hidden." },

  // ---- Customer and growth ----
  { id: "X1", group: "customers", name: "Customer report", question: "Who are my best customers?", specChart: "Bar", status: "full", drill: { dataset: "trips", map: { customer: "customer" } },
    spec: { dataset: "customers", range: { preset: "last90" }, columns: m("customer", "trips", "revenue", "margin", "marginPct", "rating", "repeat"), sort: { key: "revenue", dir: "desc" }, chart: { type: "bar", x: "customer", y: ["revenue"] } },
    note: "Customers are matched by the name on the trip. Came back means trips on more than one day in the dates picked." },
  { id: "X2", group: "customers", name: "Satisfaction", question: "How happy are customers?", specChart: "Line", status: "partial",
    spec: { dataset: "ratings", range: { preset: "last90" }, columns: m("date", "source", "driver", "rating", "nps", "comment", "complaints"), sort: { key: "date", dir: "desc" }, chart: { type: "line", x: "date", y: ["rating"] } },
    note: "NPS is shown as the average 0 to 10 recommend score, not as the promoters minus detractors figure." },
  { id: "X3", group: "customers", name: "Growth", question: "Am I growing?", specChart: "Line", status: "full",
    spec: { dataset: "monthly", range: { preset: "last12months" }, columns: m("month", "trips", "revenue", "newCustomers", "newDrivers"), sort: { key: "month", dir: "asc" }, chart: { type: "line", x: "month", y: ["revenue"] } } },
  { id: "X4", group: "customers", name: "Capacity vs demand", question: "Do I have enough cars and drivers?", specChart: "Area chart", status: "partial",
    spec: { dataset: "capacity", range: { preset: "last30" }, columns: m("date", "demand", "unmet", "drivers", "cars"), sort: { key: "date", dir: "asc" }, chart: { type: "area", x: "date", y: ["demand", "drivers", "cars"] } },
    note: "Demand is jobs scheduled that day. Drivers and cars are those that worked. Not done means jobs left unassigned, failed or pending." },
];

export const CATALOG_BY_ID = new Map(CATALOG.map((r) => [r.id, r]));
