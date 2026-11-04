-- Owner Portal, phase 3: drivers.
-- A driver is a user with role "driver". Their record is driver_profiles (one row each, already used by the driver app); this adds the portal's fields.
-- Nothing here changes how existing driver data is stored: columns are added, and every existing driver is backfilled as "active".

ALTER TABLE driver_profiles
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('onboarding','active','off_duty','suspended')),
  ADD COLUMN status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  ADD COLUMN address text CHECK (address IS NULL OR length(address) <= 300),
  ADD COLUMN birth_date date,
  ADD COLUMN languages text[] NOT NULL DEFAULT '{}',
  ADD COLUMN home_base text CHECK (home_base IS NULL OR length(home_base) <= 200),
  ADD COLUMN team_id uuid,
  ADD COLUMN employment_type text NOT NULL DEFAULT 'employee' CHECK (employment_type IN ('employee','contractor')),
  ADD COLUMN work_permit_required boolean NOT NULL DEFAULT false,
  -- Bank and tax: only an institution name and the last digits are kept here. The full account number belongs with the payment provider.
  ADD COLUMN payout_method text CHECK (payout_method IS NULL OR payout_method IN ('direct_deposit','etransfer','cheque','cash')),
  ADD COLUMN bank_institution text CHECK (bank_institution IS NULL OR length(bank_institution) <= 120),
  ADD COLUMN bank_account_last4 text CHECK (bank_account_last4 IS NULL OR bank_account_last4 ~ '^[0-9]{2,4}$'),
  ADD COLUMN tax_form text CHECK (tax_form IS NULL OR tax_form IN ('td1','t4a_contractor','gst_hst_number','none')),
  ADD COLUMN tax_form_received_on date,
  ADD COLUMN leaderboard_opt_out boolean NOT NULL DEFAULT false,
  ADD COLUMN offboarded_at timestamptz,
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- Every driver user gets a record. Existing drivers stay active; a driver who joins through an invitation starts in onboarding (set by the invite flow).
CREATE OR REPLACE FUNCTION ensure_driver_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'driver' THEN
    INSERT INTO driver_profiles (user_id, org_id) VALUES (NEW.id, NEW.org_id) ON CONFLICT (user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_driver_profile AFTER INSERT OR UPDATE OF role ON users FOR EACH ROW EXECUTE FUNCTION ensure_driver_profile();
INSERT INTO driver_profiles (user_id, org_id, status) SELECT id, org_id, 'active' FROM users WHERE role = 'driver' ON CONFLICT (user_id) DO NOTHING;

-- ---- onboarding checklist: one row per step, approved or rejected by the owner with a reason --------------------------------------
CREATE TABLE driver_onboarding_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL,
  step text NOT NULL CHECK (step IN ('personal_details','license','background_check','vehicle_training','contract','bank_details','test_trip')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','approved','rejected')),
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  submitted_at timestamptz, decided_by uuid, decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, step),
  FOREIGN KEY (driver_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);
-- When the last reminder went out, so a driver is nudged at most once every few days.
ALTER TABLE driver_profiles ADD COLUMN last_reminded_at timestamptz;

-- ---- notes, warnings, praise, coaching with follow-up dates -----------------------------------------------------------------------
CREATE TABLE driver_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'note' CHECK (kind IN ('note','warning','praise','coaching','improvement_plan','private')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  noted_on date NOT NULL DEFAULT current_date,
  due_on date, done_on date,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  FOREIGN KEY (driver_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);
CREATE INDEX driver_notes_driver ON driver_notes (org_id, driver_id, noted_on DESC);

CREATE TABLE driver_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL,
  metric text NOT NULL CHECK (metric IN ('trips','on_time_rate','rating','earnings_cents','safety_score')),
  target double precision NOT NULL CHECK (target >= 0),
  period text NOT NULL DEFAULT 'month' CHECK (period IN ('week','month')),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  FOREIGN KEY (driver_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);

CREATE TABLE driver_trainings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL,
  course text NOT NULL CHECK (length(course) BETWEEN 1 AND 200),
  required boolean NOT NULL DEFAULT false,
  completed_on date, expires_on date,
  score int CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  certificate_ref text CHECK (certificate_ref IS NULL OR length(certificate_ref) <= 200),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  FOREIGN KEY (driver_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);

-- Safety events typed in by the office or fed by a device or a partner. (Counts feed the safety score.)
CREATE TABLE driver_safety_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL, vehicle_id uuid,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('speeding','harsh_brake','harsh_turn','phone_use','late_night','incident','ticket')),
  severity int NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
  detail text CHECK (detail IS NULL OR length(detail) <= 1000),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','device','import')),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  FOREIGN KEY (driver_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);
CREATE INDEX driver_safety_driver ON driver_safety_events (org_id, driver_id, at DESC);

-- documents: reminders, archive and audit like the vehicle ones (columns were added in 019)
-- ---- what customers and the app say about each trip, used in the driver score -----------------------------------------------------------
ALTER TABLE portal_trips
  ADD COLUMN rating int CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  ADD COLUMN cleanliness int CHECK (cleanliness IS NULL OR cleanliness BETWEEN 1 AND 5),
  ADD COLUMN on_time boolean,
  ADD COLUMN complaint text CHECK (complaint IS NULL OR length(complaint) <= 1000);

-- ---- company-wide portal settings (score weights, overtime rule, leaderboard switch, which onboarding steps are required ...) ------------
CREATE TABLE portal_settings (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['driver_onboarding_steps','driver_notes','driver_goals','driver_trainings','driver_safety_events','portal_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
