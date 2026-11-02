-- Routes and stops. Foreign keys include org_id so a row can never point at another
-- organization's vehicle, driver or route (plain FK checks bypass Row-Level Security).
ALTER TABLE vehicles ADD CONSTRAINT vehicles_id_org UNIQUE (id, org_id);
ALTER TABLE users ADD CONSTRAINT users_id_org UNIQUE (id, org_id);

CREATE TABLE routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  route_date date NOT NULL,
  vehicle_id uuid,
  driver_id uuid,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (vehicle_id, org_id) REFERENCES vehicles (id, org_id) ON DELETE SET NULL (vehicle_id),
  FOREIGN KEY (driver_id, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (driver_id)
);
CREATE INDEX routes_org_date ON routes (org_id, route_date);

CREATE TABLE stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  route_id uuid NOT NULL,
  sequence int NOT NULL CHECK (sequence > 0),
  name text NOT NULL,
  address text,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  radius_m int NOT NULL DEFAULT 75 CHECK (radius_m BETWEEN 10 AND 1000),
  window_start timestamptz,
  window_end timestamptz,
  packages int NOT NULL DEFAULT 0 CHECK (packages >= 0),
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','arrived','done','failed','skipped')),
  failure_reason text,
  eta timestamptz,
  arrived_at timestamptz,
  departed_at timestamptz,
  CHECK (window_end IS NULL OR window_start IS NULL OR window_end > window_start),
  -- Reordering rewrites several sequences in one statement, so check uniqueness at commit.
  CONSTRAINT stops_route_sequence UNIQUE (route_id, sequence) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (route_id, org_id) REFERENCES routes (id, org_id) ON DELETE CASCADE
);
CREATE INDEX stops_route ON stops (route_id, sequence);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['routes','stops'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
