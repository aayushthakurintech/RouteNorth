-- Phase 5: smarter planning and safety.
-- driver preferences, territories, rewards, lone-worker check-ins and dash cam clips. Row-Level Security on every table.

ALTER TABLE driver_profiles ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE territories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  color text NOT NULL DEFAULT '#2563eb' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  polygon jsonb NOT NULL CHECK (jsonb_typeof(polygon) = 'array'),
  driver_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX territories_org ON territories (org_id);

CREATE TABLE reward_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  metric text NOT NULL CHECK (metric IN ('driverScore','onTimeRate','stopsDone','csat','speedingEvents','harshBrakes')),
  op text NOT NULL DEFAULT 'gte' CHECK (op IN ('gte','lte')),
  target numeric NOT NULL,
  bonus numeric NOT NULL CHECK (bonus >= 0 AND bonus <= 100000),
  period text NOT NULL DEFAULT 'month' CHECK (period IN ('week','month')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES reward_rules(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  value numeric,
  amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'earned' CHECK (status IN ('earned','paid','void')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, driver_id, period_start)
);
CREATE INDEX rewards_org_driver ON rewards (org_id, driver_id);

CREATE TABLE checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  every_min int NOT NULL CHECK (every_min BETWEEN 5 AND 480),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  last_ok_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (note IS NULL OR length(note) <= 300),
  lat double precision, lng double precision
);
CREATE INDEX checkins_org_active ON checkins (org_id) WHERE ended_at IS NULL;

CREATE TABLE video_clips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id uuid,
  driver_id uuid,
  event_kind text NOT NULL CHECK (event_kind IN ('speeding','harsh_brake','harsh_accel','harsh_corner','crash','sos','incident','other')),
  event_at timestamptz NOT NULL,
  url text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 1000),
  note text CHECK (note IS NULL OR length(note) <= 500),
  incident_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_clips_org_at ON video_clips (org_id, event_at DESC);

ALTER TABLE help_requests DROP CONSTRAINT IF EXISTS help_requests_kind_check;
ALTER TABLE help_requests ADD CONSTRAINT help_requests_kind_check CHECK (kind IN
  ('flat_tire','breakdown','accident','medical','wrong_address','customer_not_home','access_problem','other','sos','crash'));

ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_kind_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_kind_check CHECK (kind IN
  ('late_risk','off_route','long_idle','speeding','geofence','offline','harsh_driving','document_expiry','maintenance_due','cost_anomaly','custom_metric','needs_break','help_request',
   'fatigue','checkin_missed','crash','budget'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['territories','reward_rules','rewards','checkins','video_clips'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
