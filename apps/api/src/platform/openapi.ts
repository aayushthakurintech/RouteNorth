import { RESOURCES } from "../resources/defs.js";

const bearer = [{ apiKey: [] }];
const json = (schema: unknown = { type: "object" }) => ({ content: { "application/json": { schema } } });
const ok = (description = "OK") => ({ description, ...json() });
const param = (name: string, where: "path" | "query", description: string, required = where === "path") => ({ name, in: where, required, description, schema: { type: "string" } });

/** A small OpenAPI document for what an integration needs. Kept in code so it cannot drift from the names the API really has. */
export function openApiDocument(baseUrl: string) {
  const resourceNames = RESOURCES.map((r) => r.name);
  return {
    openapi: "3.0.3",
    info: {
      title: "RouteNorth API", version: "1.0.0",
      description: "Create an API key under Integrations, then send it as `Authorization: Bearer rn_api_…`. Read keys can only read; write keys can also change jobs, routes and fleet records (they act like a dispatcher). Responses are JSON. Errors have a `message`. Feeds and inbound email use their own keys.",
    },
    servers: [{ url: baseUrl }],
    components: { securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "An API key from Integrations" } } },
    paths: {
      "/vehicles/live": { get: { summary: "Latest position of every vehicle", tags: ["Tracking"], security: bearer, responses: { 200: ok() } } },
      "/vehicles/{deviceId}/track": { get: { summary: "Positions of one device over time", tags: ["Tracking"], security: bearer, parameters: [param("deviceId", "path", "Device id"), param("from", "query", "Start, ISO time", false), param("to", "query", "End, ISO time", false)], responses: { 200: ok() } } },
      "/vehicles/{deviceId}/trips": { get: { summary: "Trips of one device", tags: ["Tracking"], security: bearer, parameters: [param("deviceId", "path", "Device id")], responses: { 200: ok() } } },
      "/r/{resource}": {
        get: { summary: "List records", description: `Resources: ${resourceNames.join(", ")}. Add ?q= to search and ?field=value to filter.`, tags: ["Records"], security: bearer, parameters: [param("resource", "path", "Resource name"), param("q", "query", "Search text", false)], responses: { 200: ok() } },
        post: { summary: "Create a record (write key)", description: "Create a job with `POST /r/jobs` and a body such as {\"title\":\"Deliver pallet\",\"address\":\"1 Main St\",\"scheduledDate\":\"2026-03-10\"}.", tags: ["Records"], security: bearer, parameters: [param("resource", "path", "Resource name")], requestBody: { required: true, ...json() }, responses: { 201: ok("Created"), 400: ok("Validation error") } },
      },
      "/r/{resource}/{id}": {
        get: { summary: "One record", tags: ["Records"], security: bearer, parameters: [param("resource", "path", "Resource name"), param("id", "path", "Record id")], responses: { 200: ok(), 404: ok("Not found") } },
        patch: { summary: "Change a record (write key)", tags: ["Records"], security: bearer, parameters: [param("resource", "path", "Resource name"), param("id", "path", "Record id")], requestBody: { required: true, ...json() }, responses: { 200: ok() } },
        delete: { summary: "Delete a record (write key)", tags: ["Records"], security: bearer, parameters: [param("resource", "path", "Resource name"), param("id", "path", "Record id")], responses: { 200: ok() } },
      },
      "/jobs/board": { get: { summary: "Unassigned jobs, routes and drivers for a day", tags: ["Dispatch"], security: bearer, parameters: [param("date", "query", "Day, YYYY-MM-DD", false)], responses: { 200: ok() } } },
      "/jobs/{id}/assign": { post: { summary: "Assign a job to a driver (write key)", tags: ["Dispatch"], security: bearer, parameters: [param("id", "path", "Job id")], requestBody: { required: true, ...json() }, responses: { 200: ok() } } },
      "/jobs/{id}/status": { post: { summary: "Move a job to a new status (write key)", tags: ["Dispatch"], security: bearer, parameters: [param("id", "path", "Job id")], requestBody: { required: true, ...json() }, responses: { 200: ok() } } },
      "/routes": { get: { summary: "Routes for a day", tags: ["Dispatch"], security: bearer, parameters: [param("date", "query", "Day, YYYY-MM-DD", false)], responses: { 200: ok() } } },
      "/reports/datasets": { get: { summary: "Datasets reports can use", tags: ["Reports"], security: bearer, responses: { 200: ok() } } },
      "/webhooks": { get: { summary: "Webhook subscriptions (admin)", tags: ["Webhooks"], security: bearer, responses: { 200: ok() } } },
      "/feeds/data/{dataset}": { get: { summary: "A dataset as CSV, JSON or NDJSON, for spreadsheets, BI tools and warehouse loads", description: "Use a feed key in `?key=` when the tool cannot send headers. Default range is the last 30 days; use from and to (YYYY-MM-DD) for up to a year.", tags: ["Feeds"], parameters: [param("dataset", "path", "Dataset key"), param("format", "query", "csv, json or ndjson", false), param("from", "query", "Start day", false), param("to", "query", "End day", false), param("key", "query", "Feed key", false)], responses: { 200: ok() } } },
      "/feeds/calendar.ics": { get: { summary: "Routes as a calendar to subscribe to", tags: ["Feeds"], parameters: [param("key", "query", "Feed key"), param("driverId", "query", "Only this driver's routes", false)], responses: { 200: { description: "iCalendar" } } } },
      "/inbound/email/{key}": { post: { summary: "Turn an email into a job", description: "Accepts JSON or a form with from, subject and text (also the field names of common inbound-email services).", tags: ["Inbound"], parameters: [param("key", "path", "Inbound key")], requestBody: { required: true, ...json({ type: "object", properties: { from: { type: "string" }, subject: { type: "string" }, text: { type: "string" } } }) }, responses: { 200: ok() } } },
    },
    "x-webhooks": {
      description: "Webhook deliveries are POSTed as JSON with headers routenorth-event, routenorth-delivery and routenorth-signature (`t=<unix seconds>,v1=<hex>`). The v1 value is the hex HMAC-SHA256 of \"<timestamp>.<body>\" with the subscription secret. Failed deliveries retry after 1, 5, 30, 120 and 720 minutes.",
    },
  };
}
