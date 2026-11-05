-- Telemetry: the sensor values trackers send with a position, alarms/events from the device, and
-- counters for what the ingest pipeline refused (so data quality is visible, not silent).

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS altitude real,
  ADD COLUMN IF NOT EXISTS hdop real,
  ADD COLUMN IF NOT EXISTS satellites smallint,
  ADD COLUMN IF NOT EXISTS battery_pct real,
  ADD COLUMN IF NOT EXISTS ext_voltage real,
  ADD COLUMN IF NOT EXISTS fuel_level_pct real,
  ADD COLUMN IF NOT EXISTS rpm integer,
  ADD COLUMN IF NOT EXISTS engine_hours real,
  ADD COLUMN IF NOT EXISTS coolant_c real,
  ADD COLUMN IF NOT EXISTS signal smallint,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'traccar',
  ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE latest_positions
  ADD COLUMN IF NOT EXISTS altitude real,
  ADD COLUMN IF NOT EXISTS hdop real,
  ADD COLUMN IF NOT EXISTS satellites smallint,
  ADD COLUMN IF NOT EXISTS battery_pct real,
  ADD COLUMN IF NOT EXISTS ext_voltage real,
  ADD COLUMN IF NOT EXISTS fuel_level_pct real,
  ADD COLUMN IF NOT EXISTS rpm integer,
  ADD COLUMN IF NOT EXISTS engine_hours real,
  ADD COLUMN IF NOT EXISTS coolant_c real,
  ADD COLUMN IF NOT EXISTS signal smallint,
  ADD COLUMN IF NOT EXISTS odometer double precision,
  ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now();

-- Events a tracker raises itself (SOS, harsh braking from its accelerometer, power cut, tamper…).
CREATE TABLE IF NOT EXISTS device_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  time timestamptz NOT NULL,
  kind text NOT NULL,
  severity smallint NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
  value double precision,
  lat double precision,
  lng double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, time, kind)
);
CREATE INDEX IF NOT EXISTS device_events_org_time ON device_events (org_id, time DESC);
CREATE INDEX IF NOT EXISTS device_events_device_time ON device_events (device_id, time DESC);
ALTER TABLE device_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON device_events;
CREATE POLICY tenant_isolation ON device_events
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- What the pipeline accepted and refused, per organization and day. Counters only: no positions, no names.
CREATE TABLE IF NOT EXISTS ingest_counters (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day date NOT NULL,
  outcome text NOT NULL,           -- stored | latest_only | history_only | duplicate | rejected:<reason>
  n bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day, outcome)
);
ALTER TABLE ingest_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_counters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingest_counters;
CREATE POLICY tenant_isolation ON ingest_counters
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Fixes we cannot attribute to an organization (unknown device ids) are counted globally, by source only.
CREATE TABLE IF NOT EXISTS ingest_unknown (
  day date NOT NULL,
  source text NOT NULL,
  n bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);

-- Generic JSON feed (vendor APIs, phone apps, gateways) registers devices with source 'api'.
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_source_check;
ALTER TABLE devices ADD CONSTRAINT devices_source_check CHECK (source IN ('traccar','geotab','samsara','terminal','simulator','api'));
ALTER TABLE devices ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS model text;

-- A device can only point at a vehicle of its own organization (plain FKs bypass RLS, so say it in the key).
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_id_org;
ALTER TABLE devices ADD CONSTRAINT devices_id_org UNIQUE (id, org_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_vehicle_org_fk') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_vehicle_org_fk FOREIGN KEY (vehicle_id, org_id) REFERENCES vehicles (id, org_id) ON DELETE SET NULL (vehicle_id);
  END IF;
END $$;
