-- Owner Portal, phase 2: vehicles.
-- Adds the spec's vehicle fields next to the ones RouteNorth already has (name = the spec's "nickname", kind = "vehicle_type",
-- capacity_kg = "max_load_kg", capacity_m3 = "cargo_volume"). Nothing is renamed, dropped or rewritten.
-- Money added here is whole cents (bigint). Older dollar columns stay as they were; "generated" cents columns beside them
-- let reports add old and new records up to the exact cent.

-- ---- vehicles ---------------------------------------------------------------------------------------------------
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_kind_check;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_kind_check CHECK (kind IN ('truck','bus','van','car','suv','bike','other'));
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_status_check;
-- in_shop is shown as "In service" and retired as "Out of service" (older names kept so existing rows stay valid).
ALTER TABLE vehicles ADD CONSTRAINT vehicles_status_check CHECK (status IN ('active','in_shop','retired','out_of_service','sold'));
ALTER TABLE vehicles
  ADD COLUMN trim text CHECK (trim IS NULL OR length(trim) <= 60),
  ADD COLUMN seats int CHECK (seats IS NULL OR seats BETWEEN 0 AND 100),
  ADD COLUMN engine text CHECK (engine IS NULL OR length(engine) <= 80),
  ADD COLUMN tire_size text CHECK (tire_size IS NULL OR length(tire_size) <= 40),
  ADD COLUMN ownership_type text CHECK (ownership_type IS NULL OR ownership_type IN ('owned','financed','leased')),
  ADD COLUMN purchase_date date,
  ADD COLUMN purchase_price_cents bigint CHECK (purchase_price_cents IS NULL OR purchase_price_cents >= 0),
  ADD COLUMN finance_payment_cents bigint CHECK (finance_payment_cents IS NULL OR finance_payment_cents >= 0),
  ADD COLUMN finance_interval text CHECK (finance_interval IS NULL OR finance_interval IN ('weekly','biweekly','monthly')),
  ADD COLUMN finance_end_date date,
  ADD COLUMN interest_rate_pct numeric(6,3) CHECK (interest_rate_pct IS NULL OR interest_rate_pct BETWEEN 0 AND 100),
  ADD COLUMN residual_value_cents bigint CHECK (residual_value_cents IS NULL OR residual_value_cents >= 0),
  ADD COLUMN current_value_cents bigint CHECK (current_value_cents IS NULL OR current_value_cents >= 0),
  ADD COLUMN current_driver_id uuid,
  ADD COLUMN insurance_provider text CHECK (insurance_provider IS NULL OR length(insurance_provider) <= 120),
  ADD COLUMN policy_number text CHECK (policy_number IS NULL OR length(policy_number) <= 80),
  ADD COLUMN insurance_expiry date,
  ADD COLUMN service_interval_km int CHECK (service_interval_km IS NULL OR service_interval_km > 0),
  ADD COLUMN service_interval_days int CHECK (service_interval_days IS NULL OR service_interval_days > 0),
  ADD COLUMN service_interval_hours int CHECK (service_interval_hours IS NULL OR service_interval_hours > 0),
  ADD COLUMN engine_hours numeric(10,1) CHECK (engine_hours IS NULL OR engine_hours >= 0),
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN sold_on date,
  ADD COLUMN sale_price_cents bigint CHECK (sale_price_cents IS NULL OR sale_price_cents >= 0),
  ADD COLUMN draft boolean NOT NULL DEFAULT false,
  ADD COLUMN idle_alert_days int CHECK (idle_alert_days IS NULL OR idle_alert_days BETWEEN 1 AND 365),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by uuid,
  ADD COLUMN archived_at timestamptz;
CREATE INDEX vehicles_archived ON vehicles (org_id, archived_at);
-- Plate and VIN are unique per company (archived cars are left out so a plate can be reused after a sale). If an existing
-- company already has duplicates, the index is skipped (not failed) and the API warns about duplicates instead.
DO $$ BEGIN
  CREATE UNIQUE INDEX vehicles_plate_unique ON vehicles (org_id, lower(plate)) WHERE plate IS NOT NULL AND plate <> '' AND archived_at IS NULL;
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'vehicles_plate_unique skipped: duplicate plates exist'; END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX vehicles_vin_unique ON vehicles (org_id, upper(vin)) WHERE vin IS NOT NULL AND vin <> '' AND archived_at IS NULL;
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'vehicles_vin_unique skipped: duplicate VINs exist'; END $$;

-- ---- older child tables: more fields, cents beside dollars ----------------------------------------------------------
ALTER TABLE documents ADD COLUMN archived_at timestamptz, ADD COLUMN created_by uuid, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_owner_kind_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_owner_kind_check CHECK (owner_kind IN
  ('incident','job','document','vehicle','driver','equipment','maintenance','assignment','inspection','fuel','work_order','expense','payout_dispute','driver_document','driver_step','invoice'));
ALTER TABLE attachments ADD COLUMN archived_at timestamptz;

ALTER TABLE maintenance_logs
  ADD COLUMN labour_cents bigint CHECK (labour_cents IS NULL OR labour_cents >= 0),
  ADD COLUMN parts_cents bigint CHECK (parts_cents IS NULL OR parts_cents >= 0),
  ADD COLUMN parts_note text CHECK (parts_note IS NULL OR length(parts_note) <= 500),
  ADD COLUMN kind text NOT NULL DEFAULT 'service' CHECK (kind IN ('service','repair','inspection','tires','other')),
  ADD COLUMN work_order_id uuid,
  ADD COLUMN next_due_on date, ADD COLUMN next_due_km double precision,
  ADD COLUMN created_by uuid, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN archived_at timestamptz,
  ADD COLUMN total_cents bigint GENERATED ALWAYS AS (
    CASE WHEN labour_cents IS NOT NULL OR parts_cents IS NOT NULL THEN coalesce(labour_cents, 0) + coalesce(parts_cents, 0)
         ELSE round(cost::numeric * 100)::bigint END) STORED;
ALTER TABLE fuel_logs
  ADD COLUMN unit text NOT NULL DEFAULT 'L' CHECK (unit IN ('L','kWh')),
  ADD COLUMN created_by uuid, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN archived_at timestamptz,
  ADD COLUMN cost_cents bigint GENERATED ALWAYS AS (round(cost::numeric * 100)::bigint) STORED;
ALTER TABLE inspections
  ADD COLUMN signed_off_by uuid, ADD COLUMN signed_off_at timestamptz, ADD COLUMN sign_off_note text CHECK (sign_off_note IS NULL OR length(sign_off_note) <= 500),
  ADD COLUMN created_by uuid, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN archived_at timestamptz;
ALTER TABLE maintenance_plans ADD COLUMN created_by uuid, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN archived_at timestamptz;
ALTER TABLE incidents
  ADD COLUMN repair_cost_cents bigint CHECK (repair_cost_cents IS NULL OR repair_cost_cents >= 0),
  ADD COLUMN claim_number text CHECK (claim_number IS NULL OR length(claim_number) <= 80),
  ADD COLUMN claim_status text CHECK (claim_status IS NULL OR claim_status IN ('none','filed','approved','denied','paid')),
  ADD COLUMN ticket boolean NOT NULL DEFAULT false, ADD COLUMN fine_cents bigint CHECK (fine_cents IS NULL OR fine_cents >= 0),
  ADD COLUMN created_by uuid, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN archived_at timestamptz;

-- ---- trips (what a job earned and cost): one row per trip a driver drove in a vehicle ---------------------------------
-- The pay module (next phase) adds the rate card versions and pay lines. Revenue is whole cents.
CREATE TABLE portal_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id uuid, driver_id uuid, job_id uuid, route_id uuid,
  customer_name text CHECK (customer_name IS NULL OR length(customer_name) <= 200),
  title text CHECK (title IS NULL OR length(title) <= 200),
  started_at timestamptz NOT NULL, ended_at timestamptz,
  distance_m int NOT NULL DEFAULT 0 CHECK (distance_m >= 0),
  duration_s int NOT NULL DEFAULT 0 CHECK (duration_s >= 0),
  waiting_s int NOT NULL DEFAULT 0 CHECK (waiting_s >= 0),
  stops int NOT NULL DEFAULT 1 CHECK (stops >= 0),
  weight_kg double precision NOT NULL DEFAULT 0 CHECK (weight_kg >= 0),
  zone text CHECK (zone IS NULL OR length(zone) <= 80),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','cancelled','failed','no_show')),
  revenue_cents bigint NOT NULL DEFAULT 0 CHECK (revenue_cents >= 0),
  tip_cents bigint NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  toll_cents bigint NOT NULL DEFAULT 0 CHECK (toll_cents >= 0),
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,   -- peak, night, weekend, holiday, weather, surge, region ...
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','job','import','test')),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  UNIQUE (org_id, job_id)
);
CREATE INDEX portal_trips_time ON portal_trips (org_id, started_at DESC);
CREATE INDEX portal_trips_vehicle ON portal_trips (org_id, vehicle_id, started_at DESC);
CREATE INDEX portal_trips_driver ON portal_trips (org_id, driver_id, started_at DESC);

-- ---- hand-overs: which driver has which car, and when ------------------------------------------------------------------
CREATE TABLE vehicle_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL, driver_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'day' CHECK (kind IN ('day','week','permanent')),
  start_at timestamptz NOT NULL, end_at timestamptz,
  odometer_start_km double precision CHECK (odometer_start_km IS NULL OR odometer_start_km >= 0),
  odometer_end_km double precision CHECK (odometer_end_km IS NULL OR odometer_end_km >= 0),
  fuel_start_pct int CHECK (fuel_start_pct IS NULL OR fuel_start_pct BETWEEN 0 AND 100),
  fuel_end_pct int CHECK (fuel_end_pct IS NULL OR fuel_end_pct BETWEEN 0 AND 100),
  damage_notes text CHECK (damage_notes IS NULL OR length(damage_notes) <= 2000),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  CHECK (end_at IS NULL OR end_at > start_at),
  FOREIGN KEY (vehicle_id, org_id) REFERENCES vehicles (id, org_id)
);
CREATE INDEX vehicle_assignments_vehicle ON vehicle_assignments (org_id, vehicle_id, start_at DESC);
CREATE INDEX vehicle_assignments_driver ON vehicle_assignments (org_id, driver_id, start_at DESC);

-- ---- shops and work orders ------------------------------------------------------------------------------------------
CREATE TABLE shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120), phone text CHECK (phone IS NULL OR length(phone) <= 40), email text CHECK (email IS NULL OR length(email) <= 200),
  address text CHECK (address IS NULL OR length(address) <= 300), notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  UNIQUE (id, org_id)
);
CREATE TABLE work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL, shop_id uuid, plan_id uuid,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200), description text CHECK (description IS NULL OR length(description) <= 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','awaiting_approval','approved','closed','cancelled')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','schedule','inspection','automation')),
  estimate_cents bigint CHECK (estimate_cents IS NULL OR estimate_cents >= 0), approved_by uuid, approved_at timestamptz,
  actual_cents bigint CHECK (actual_cents IS NULL OR actual_cents >= 0), invoice_ref text CHECK (invoice_ref IS NULL OR length(invoice_ref) <= 80),
  opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz, due_on date,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  FOREIGN KEY (vehicle_id, org_id) REFERENCES vehicles (id, org_id),
  FOREIGN KEY (shop_id, org_id) REFERENCES shops (id, org_id) ON DELETE SET NULL (shop_id)
);
CREATE INDEX work_orders_vehicle ON work_orders (org_id, vehicle_id, opened_at DESC);
CREATE UNIQUE INDEX work_orders_one_open_per_plan ON work_orders (org_id, plan_id) WHERE plan_id IS NOT NULL AND status NOT IN ('closed','cancelled');

-- ---- warranty and recall tracker, tire and part life --------------------------------------------------------------------
CREATE TABLE vehicle_warranties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('warranty','recall')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200), provider text CHECK (provider IS NULL OR length(provider) <= 120),
  starts_on date, expires_on date, km_limit int CHECK (km_limit IS NULL OR km_limit > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')), notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  FOREIGN KEY (vehicle_id, org_id) REFERENCES vehicles (id, org_id)
);
CREATE TABLE vehicle_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('tire','battery','brakes','other')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120), position text CHECK (position IS NULL OR length(position) <= 40),
  installed_on date, installed_km double precision CHECK (installed_km IS NULL OR installed_km >= 0),
  life_km int CHECK (life_km IS NULL OR life_km > 0), life_days int CHECK (life_days IS NULL OR life_days > 0),
  cost_cents bigint CHECK (cost_cents IS NULL OR cost_cents >= 0), replaced_on date, notes text CHECK (notes IS NULL OR length(notes) <= 500),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  FOREIGN KEY (vehicle_id, org_id) REFERENCES vehicles (id, org_id)
);

-- ---- expenses (company wide; a vehicle or driver can be named) ----------------------------------------------------------
CREATE TABLE finance_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  spent_on date NOT NULL,
  category text NOT NULL CHECK (category IN ('fuel','maintenance','insurance','finance','tolls','parking','fines','tires','software','payroll','other')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  tax_cents bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  vendor text CHECK (vendor IS NULL OR length(vendor) <= 200), description text CHECK (description IS NULL OR length(description) <= 500),
  vehicle_id uuid, driver_id uuid,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','bank_file')),
  external_ref text CHECK (external_ref IS NULL OR length(external_ref) <= 120),
  approved_by uuid,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE INDEX finance_expenses_date ON finance_expenses (org_id, spent_on DESC);
CREATE INDEX finance_expenses_vehicle ON finance_expenses (org_id, vehicle_id, spent_on DESC);
CREATE UNIQUE INDEX finance_expenses_ref ON finance_expenses (org_id, external_ref) WHERE external_ref IS NOT NULL AND archived_at IS NULL;

-- ---- Row-Level Security on every new table ------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['portal_trips','vehicle_assignments','shops','work_orders','vehicle_warranties','vehicle_parts','finance_expenses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
