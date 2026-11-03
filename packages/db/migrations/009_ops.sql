-- Phase 2: operations. Vehicle and driver records, documents, maintenance, fuel, equipment,
-- inspections, incidents, depots, jobs, geofences, route templates and share links.
-- Every table carries org_id and is protected by Row-Level Security (see the loop at the end).

-- Richer vehicle profile: capacity, truck limits, electric range.
ALTER TABLE vehicles
  ADD COLUMN make text, ADD COLUMN model text, ADD COLUMN year int CHECK (year IS NULL OR year BETWEEN 1950 AND 2100),
  ADD COLUMN color text, ADD COLUMN photo_data_url text CHECK (photo_data_url IS NULL OR length(photo_data_url) <= 400000),
  ADD COLUMN fuel_type text CHECK (fuel_type IS NULL OR fuel_type IN ('diesel','gasoline','electric','hybrid','propane','cng')),
  ADD COLUMN capacity_kg double precision CHECK (capacity_kg IS NULL OR capacity_kg >= 0),
  ADD COLUMN capacity_m3 double precision CHECK (capacity_m3 IS NULL OR capacity_m3 >= 0),
  ADD COLUMN capacity_items int CHECK (capacity_items IS NULL OR capacity_items >= 0),
  ADD COLUMN height_m double precision CHECK (height_m IS NULL OR height_m > 0),
  ADD COLUMN weight_kg double precision CHECK (weight_kg IS NULL OR weight_kg > 0),
  ADD COLUMN hazmat boolean NOT NULL DEFAULT false,
  ADD COLUMN battery_kwh double precision CHECK (battery_kwh IS NULL OR battery_kwh > 0),
  ADD COLUMN range_km double precision CHECK (range_km IS NULL OR range_km > 0),
  ADD COLUMN odometer_km double precision NOT NULL DEFAULT 0 CHECK (odometer_km >= 0),
  ADD COLUMN depot_id uuid,
  ADD COLUMN notes text,
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','in_shop','retired'));

-- Driver profile (one per driver user).
CREATE TABLE driver_profiles (
  user_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone text, license_no text, license_class text, license_expiry date,
  emergency_name text, emergency_phone text, home_depot_id uuid,
  max_shift_min int NOT NULL DEFAULT 600 CHECK (max_shift_min BETWEEN 30 AND 1440),
  break_after_min int NOT NULL DEFAULT 300 CHECK (break_after_min BETWEEN 30 AND 1440),
  break_min int NOT NULL DEFAULT 30 CHECK (break_min BETWEEN 5 AND 240),
  skills text[] NOT NULL DEFAULT '{}',
  training jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);

CREATE TABLE depots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  address text, lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90), lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  radius_m int NOT NULL DEFAULT 150 CHECK (radius_m BETWEEN 20 AND 5000),
  spots int NOT NULL DEFAULT 0 CHECK (spots >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);

CREATE TABLE equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'trailer' CHECK (kind IN ('trailer','equipment')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  plate text, serial text, capacity_kg double precision,
  vehicle_id uuid, depot_id uuid,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','in_use','maintenance','retired')),
  notes text, created_at timestamptz NOT NULL DEFAULT now()
);

-- Expiring documents for a vehicle, driver or piece of equipment.
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('vehicle','driver','equipment')),
  owner_id uuid NOT NULL,
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 60),
  number text, issued_on date, expires_on date,
  remind_days int NOT NULL DEFAULT 30 CHECK (remind_days BETWEEN 0 AND 365),
  notes text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_expiry ON documents (org_id, expires_on);

-- Maintenance: a plan repeats by days and/or kilometers; logs record what was done.
CREATE TABLE maintenance_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL,
  task text NOT NULL CHECK (length(task) BETWEEN 1 AND 120),
  every_days int CHECK (every_days IS NULL OR every_days > 0),
  every_km int CHECK (every_km IS NULL OR every_km > 0),
  last_done_on date, last_done_km double precision,
  notes text, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (every_days IS NOT NULL OR every_km IS NOT NULL)
);
CREATE TABLE maintenance_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL, plan_id uuid,
  task text NOT NULL, done_on date NOT NULL, odometer_km double precision,
  cost double precision CHECK (cost IS NULL OR cost >= 0), vendor text, notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fuel_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL, driver_id uuid,
  filled_on date NOT NULL,
  litres double precision NOT NULL CHECK (litres > 0 AND litres < 5000),
  cost double precision CHECK (cost IS NULL OR cost >= 0),
  odometer_km double precision CHECK (odometer_km IS NULL OR odometer_km >= 0),
  station text, card_last4 text CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fuel_vehicle_date ON fuel_logs (org_id, vehicle_id, filled_on);

-- Digital vehicle check-in / check-out checklists.
CREATE TABLE inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL, driver_id uuid,
  kind text NOT NULL CHECK (kind IN ('check_out','check_in')),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  defects boolean NOT NULL DEFAULT false,
  odometer_km double precision CHECK (odometer_km IS NULL OR odometer_km >= 0),
  notes text, at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id uuid, driver_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL DEFAULT 'accident' CHECK (kind IN ('accident','near_miss','theft','damage','breakdown','other')),
  severity text NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor','moderate','major')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 4000),
  lat double precision, lng double precision, location text,
  injuries boolean NOT NULL DEFAULT false, police_report text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Files on any record (incident photos, job attachments, documents).
CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('incident','job','document','vehicle','driver','equipment')),
  owner_id uuid NOT NULL,
  name text NOT NULL, content_type text NOT NULL, size_bytes int NOT NULL CHECK (size_bytes > 0),
  data bytea NOT NULL, created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_owner ON attachments (org_id, owner_kind, owner_id);

-- Jobs: the work to be done. A job may be placed on a route as a stop.
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ref text,
  type text NOT NULL DEFAULT 'delivery' CHECK (type IN ('pickup','delivery','service','inspection')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status text NOT NULL DEFAULT 'unassigned' CHECK (status IN ('unassigned','assigned','started','arrived','done','failed','cancelled')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  customer_name text, customer_phone text, customer_email text,
  address text, lat double precision CHECK (lat IS NULL OR lat BETWEEN -90 AND 90), lng double precision CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  scheduled_date date, window_start timestamptz, window_end timestamptz, service_min int NOT NULL DEFAULT 5 CHECK (service_min BETWEEN 0 AND 600),
  weight_kg double precision NOT NULL DEFAULT 0 CHECK (weight_kg >= 0), volume_m3 double precision NOT NULL DEFAULT 0 CHECK (volume_m3 >= 0),
  items int NOT NULL DEFAULT 0 CHECK (items >= 0),
  skills text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  driver_id uuid, vehicle_id uuid, route_id uuid, stop_id uuid,
  reason_code text, reason_note text,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end IS NULL OR window_start IS NULL OR window_end > window_start)
);
CREATE INDEX jobs_org_date ON jobs (org_id, scheduled_date);
CREATE INDEX jobs_org_status ON jobs (org_id, status);

CREATE TABLE job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL, at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid, kind text NOT NULL, detail jsonb
);
CREATE INDEX job_events_job ON job_events (job_id, at);

ALTER TABLE stops
  ADD COLUMN weight_kg double precision NOT NULL DEFAULT 0, ADD COLUMN volume_m3 double precision NOT NULL DEFAULT 0,
  ADD COLUMN service_min int NOT NULL DEFAULT 5, ADD COLUMN priority text NOT NULL DEFAULT 'normal',
  ADD COLUMN job_id uuid, ADD COLUMN kind text NOT NULL DEFAULT 'delivery';
ALTER TABLE routes
  ADD COLUMN objective text NOT NULL DEFAULT 'time' CHECK (objective IN ('time','distance')),
  ADD COLUMN avoid text[] NOT NULL DEFAULT '{}',
  ADD COLUMN depot_id uuid, ADD COLUMN start_time time, ADD COLUMN template_id uuid,
  ADD COLUMN notes text;

-- Templates and recurrence: a template holds stops; a rule makes routes from it on matching days.
CREATE TABLE route_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  vehicle_id uuid, driver_id uuid, depot_id uuid,
  objective text NOT NULL DEFAULT 'time' CHECK (objective IN ('time','distance')),
  avoid text[] NOT NULL DEFAULT '{}',
  start_time time,
  stops jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- recurrence: {"every":"day"|"week"|"custom","days":[1..7 ISO weekday],"interval":N,"from":"YYYY-MM-DD","until":"YYYY-MM-DD"}
  recurrence jsonb,
  last_generated date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Geofences: a circle or a polygon, with alerts on enter and/or exit.
CREATE TABLE geofences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  shape text NOT NULL DEFAULT 'circle' CHECK (shape IN ('circle','polygon')),
  lat double precision, lng double precision, radius_m int CHECK (radius_m IS NULL OR radius_m BETWEEN 10 AND 100000),
  polygon jsonb,
  alert_on text NOT NULL DEFAULT 'both' CHECK (alert_on IN ('enter','exit','both','none')),
  color text, active boolean NOT NULL DEFAULT true, notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  CHECK ((shape = 'circle' AND lat IS NOT NULL AND lng IS NOT NULL AND radius_m IS NOT NULL) OR (shape = 'polygon' AND polygon IS NOT NULL))
);
CREATE TABLE geofence_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  geofence_id uuid NOT NULL, device_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('enter','exit')),
  at timestamptz NOT NULL, lat double precision, lng double precision
);
CREATE INDEX geofence_events_org_at ON geofence_events (org_id, at DESC);
CREATE TABLE geofence_state (
  geofence_id uuid NOT NULL, device_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  inside boolean NOT NULL, since timestamptz NOT NULL,
  PRIMARY KEY (geofence_id, device_id)
);

-- Live tracking links anyone can open without signing in (until they expire).
CREATE TABLE share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  device_id uuid, route_id uuid, label text,
  expires_at timestamptz NOT NULL,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['driver_profiles','depots','equipment','documents','maintenance_plans','maintenance_logs','fuel_logs',
    'inspections','incidents','attachments','jobs','job_events','route_templates','geofences','geofence_events','geofence_state','share_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
