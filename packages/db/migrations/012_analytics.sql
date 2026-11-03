-- Phase 3: dashboards, saved reports, shared reports, alerts, goals and customer feedback.
-- Every table carries org_id and is protected by Row-Level Security (see the loop at the end).

ALTER TABLE maintenance_logs ADD COLUMN downtime_hours numeric(8,1) CHECK (downtime_hours IS NULL OR downtime_hours >= 0);
ALTER TABLE driver_profiles ADD COLUMN hourly_rate numeric(8,2) CHECK (hourly_rate IS NULL OR hourly_rate >= 0);

-- A dashboard is a list of widgets. `role_template` marks the starting layouts people can copy.
CREATE TABLE dashboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  widgets jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(widgets) = 'array' AND length(widgets::text) <= 100000),
  shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- Saved report definitions, with every earlier version kept.
CREATE TABLE report_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  spec jsonb NOT NULL CHECK (length(spec::text) <= 50000),
  shared boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE TABLE report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  report_id uuid NOT NULL, version int NOT NULL, name text NOT NULL, spec jsonb NOT NULL,
  saved_by uuid, saved_at timestamptz NOT NULL DEFAULT now(), note text,
  UNIQUE (report_id, version),
  FOREIGN KEY (report_id, org_id) REFERENCES report_defs (id, org_id) ON DELETE CASCADE
);

-- Where reports and alerts can be sent: Slack, Teams, email, SMS or a generic webhook.
CREATE TABLE notification_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('email','slack','teams','sms','webhook')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  target text NOT NULL CHECK (length(target) BETWEEN 3 AND 500),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);

CREATE TABLE report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  report_id uuid NOT NULL,
  freq text NOT NULL CHECK (freq IN ('daily','weekly','monthly')),
  hour int NOT NULL DEFAULT 7 CHECK (hour BETWEEN 0 AND 23),
  weekday int CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  monthday int CHECK (monthday IS NULL OR monthday BETWEEN 1 AND 28),
  format text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','xlsx','pdf')),
  endpoint_ids text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz, last_status text,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (report_id, org_id) REFERENCES report_defs (id, org_id) ON DELETE CASCADE
);

-- Report links that anyone can open until they expire. The token is stored only as a hash.
CREATE TABLE report_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  report_id uuid, name text NOT NULL, spec jsonb NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION resolve_report_share(p_hash text)
RETURNS TABLE (id uuid, org_id uuid, name text, spec jsonb, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.org_id, s.name, s.spec, s.expires_at FROM report_shares s WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > now()
$$;

-- What applying an optimized order saved, so dashboards can show savings from better routes.
CREATE TABLE route_savings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  route_id uuid, at timestamptz NOT NULL DEFAULT now(), saved_by uuid,
  before_km double precision NOT NULL, after_km double precision NOT NULL, before_cost double precision NOT NULL, after_cost double precision NOT NULL
);
CREATE INDEX route_savings_org_at ON route_savings (org_id, at DESC);

-- Alert rules ("if this, then that"), and the alerts they raise.
CREATE TABLE alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('late_risk','off_route','long_idle','speeding','geofence','offline','harsh_driving','document_expiry','maintenance_due','cost_anomaly','custom_metric')),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity text NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','critical')),
  endpoint_ids text[] NOT NULL DEFAULT '{}',
  notify_inapp boolean NOT NULL DEFAULT true,
  quiet_start time, quiet_end time,
  group_minutes int NOT NULL DEFAULT 30 CHECK (group_minutes BETWEEN 0 AND 1440),
  active boolean NOT NULL DEFAULT true,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id uuid, kind text NOT NULL, severity text NOT NULL, title text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  subject_kind text, subject_id text, dedupe_key text NOT NULL,
  first_at timestamptz NOT NULL DEFAULT now(), last_at timestamptz NOT NULL DEFAULT now(), count int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  acknowledged_by uuid, delivered_at timestamptz, in_digest boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX alerts_open_dedupe ON alerts (org_id, dedupe_key) WHERE status = 'open';
CREATE INDEX alerts_org_time ON alerts (org_id, last_at DESC);

-- Targets with progress, for example "on-time rate at least 95% this month".
CREATE TABLE goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  metric text NOT NULL CHECK (length(metric) BETWEEN 1 AND 60),
  target double precision NOT NULL,
  direction text NOT NULL DEFAULT 'up' CHECK (direction IN ('up','down')),
  period text NOT NULL DEFAULT 'month' CHECK (period IN ('day','week','month')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Customer feedback after a delivery: satisfaction (1 to 5) and likelihood to recommend (0 to 10).
CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id uuid, stop_id uuid, route_id uuid, driver_id uuid,
  csat int CHECK (csat IS NULL OR csat BETWEEN 1 AND 5),
  nps int CHECK (nps IS NULL OR nps BETWEEN 0 AND 10),
  comment text CHECK (comment IS NULL OR length(comment) <= 2000),
  source text NOT NULL DEFAULT 'link' CHECK (source IN ('link','portal','office')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_org_time ON feedback (org_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dashboards','report_defs','report_versions','notification_endpoints','report_schedules','report_shares','alert_rules','alerts','goals','feedback','route_savings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION resolve_report_share(text) TO routenorth_app;
  END IF;
END $$;
