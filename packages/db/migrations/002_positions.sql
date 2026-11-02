-- Positions: time-series of GPS fixes. PostGIS and TimescaleDB are used when installed
-- (docker-compose image has both); plain Postgres still works for unit tests.
CREATE TABLE IF NOT EXISTS positions (
  time timestamptz NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  speed real NOT NULL DEFAULT 0,      -- km/h
  heading real NOT NULL DEFAULT 0,
  ignition boolean,
  odometer double precision,          -- metres
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (device_id, time)
);
CREATE INDEX IF NOT EXISTS positions_org_device_time ON positions (org_id, device_id, time DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    CREATE EXTENSION IF NOT EXISTS postgis;
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326)
      GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)) STORED;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    PERFORM create_hypertable('positions', 'time', if_not_exists => TRUE);
  END IF;
END $$;

ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON positions;
CREATE POLICY tenant_isolation ON positions
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Latest position per device, kept in sync by the normalizer (also cached in Redis).
CREATE TABLE IF NOT EXISTS latest_positions (
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  time timestamptz NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  speed real NOT NULL DEFAULT 0,
  heading real NOT NULL DEFAULT 0,
  ignition boolean
);
ALTER TABLE latest_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE latest_positions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON latest_positions;
CREATE POLICY tenant_isolation ON latest_positions
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
