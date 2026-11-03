import type { WorkflowSpec } from "./spec.js";

/** Ready-made workflows an office can add with one click, then adjust. */
export interface WorkflowTemplate { id: string; name: string; description: string; spec: WorkflowSpec }

const T = (id: string, name: string, description: string, spec: Omit<WorkflowSpec, "match" | "conditions"> & Partial<WorkflowSpec>): WorkflowTemplate => ({ id, name, description, spec: { match: "all", conditions: [], ...spec } });

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  T("escalate-unpicked", "Escalate jobs nobody picks up", "If a job has no driver after 15 minutes, make it urgent and raise an alert.", {
    trigger: { kind: "job.unassigned_for", minutes: 15 },
    actions: [{ type: "set_job", params: { priority: "urgent", addTag: "escalated" } }, { type: "create_alert", params: { severity: "warn", title: "Nobody has picked up {{job.title}} after {{event.waitingMin}} minutes" } }],
  }),
  T("driver-10-min", "Tell customers their driver is 10 minutes away", "Sends the customer a message when the driver is about 10 minutes from the stop.", {
    trigger: { kind: "driver.minutes_away", minutes: 10 },
    actions: [{ type: "notify_customer", params: { event: "minutes_away" } }],
  }),
  T("invoice-on-done", "Create an invoice when a job is delivered", "Makes one invoice per job as soon as it is marked done.", {
    trigger: { kind: "job.done" },
    actions: [{ type: "create_invoice", params: {} }],
  }),
  T("replan-on-removal", "Re-plan the route when a stop is cancelled or moved", "Re-orders the stops that are left so the driver does not drive around the gap.", {
    trigger: { kind: "route.stop_removed" },
    actions: [{ type: "replan_route", params: {} }],
  }),
  T("approve-urgent", "Ask a manager to approve urgent jobs", "Urgent jobs wait for a manager's approval.", {
    trigger: { kind: "job.created" }, conditions: [{ field: "job.priority", op: "eq", value: "urgent" }],
    actions: [{ type: "request_approval", params: { kind: "job", title: "Approve urgent job: {{job.title}}" } }],
  }),
  T("bad-rating", "Flag poor ratings", "Raises an alert when a customer rates a delivery 2 or lower.", {
    trigger: { kind: "feedback.received" }, conditions: [{ field: "feedback.csat", op: "lte", value: 2 }],
    actions: [{ type: "create_alert", params: { severity: "warn", title: "A customer rated a delivery {{feedback.csat}} out of 5: {{feedback.comment}}" } }],
  }),
  T("failed-follow-up", "Follow up on failed deliveries", "When a delivery fails, tell the customer and flag the job.", {
    trigger: { kind: "job.failed" },
    actions: [{ type: "set_job", params: { addTag: "needs-follow-up" } }],
  }),
  T("tell-driver-urgent", "Tell the driver about urgent jobs", "Sends a chat message to the driver when an urgent job is added to their route.", {
    trigger: { kind: "job.assigned" }, conditions: [{ field: "job.priority", op: "eq", value: "urgent" }],
    actions: [{ type: "notify_driver", params: { text: "Urgent job added to your route: {{job.title}}" } }],
  }),
];
