-- Owner Portal, phase 4: pay rates. Rate cards with dated versions, assignments, trip pay lines, bonuses, deductions, payout runs and disputes.
-- All money is whole cents. The older `rate_cards` table (quotes) is left alone.

CREATE TABLE portal_rate_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('customer','driver')),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  UNIQUE (id, org_id)
);

-- Every edit is a new version with its own dates, so an old trip keeps pointing at the version that priced it.
CREATE TABLE portal_rate_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  card_id uuid NOT NULL, version int NOT NULL,
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND length(spec::text) <= 20000),
  starts_on date NOT NULL, ends_on date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','active')),
  big_change boolean NOT NULL DEFAULT false,
  change_note text CHECK (change_note IS NULL OR length(change_note) <= 500),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), submitted_by uuid, approved_by uuid, approved_at timestamptz,
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  UNIQUE (card_id, version),
  FOREIGN KEY (card_id, org_id) REFERENCES portal_rate_cards (id, org_id) ON DELETE CASCADE
);
CREATE INDEX portal_rate_versions_card ON portal_rate_versions (org_id, card_id, starts_on DESC);

CREATE TABLE rate_card_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  card_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('driver','customer','zone','vehicle_type','group','all')),
  target text CHECK (target IS NULL OR length(target) <= 200),
  starts_on date NOT NULL DEFAULT current_date, ends_on date,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK (kind = 'all' OR target IS NOT NULL),
  FOREIGN KEY (card_id, org_id) REFERENCES portal_rate_cards (id, org_id) ON DELETE CASCADE
);
CREATE INDEX rate_card_assignments_card ON rate_card_assignments (org_id, card_id);

ALTER TABLE portal_trips
  ADD COLUMN driver_rate_version_id uuid, ADD COLUMN customer_rate_version_id uuid,
  ADD COLUMN customer_lines jsonb, ADD COLUMN vehicle_cost_cents bigint CHECK (vehicle_cost_cents IS NULL OR vehicle_cost_cents >= 0),
  ADD COLUMN pay_calculated_at timestamptz,
  ADD COLUMN revenue_manual boolean NOT NULL DEFAULT false;      -- a price typed by hand wins over the customer rate card
-- Trips that already carry a price keep it exactly as it is (existing data never changes).
UPDATE portal_trips SET revenue_manual = true WHERE revenue_cents > 0;

-- ---- payouts --------------------------------------------------------------------------------------------------------------------------
CREATE TABLE portal_payout_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cycle text NOT NULL DEFAULT 'weekly' CHECK (cycle IN ('daily','weekly','biweekly','monthly','custom')),
  from_date date NOT NULL, to_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid','cancelled')),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date),
  UNIQUE (id, org_id)
);
CREATE TABLE portal_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL, driver_id uuid NOT NULL,
  from_date date NOT NULL, to_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sent','paid','failed','disputed')),
  earnings_cents bigint NOT NULL DEFAULT 0, bonus_cents bigint NOT NULL DEFAULT 0, tips_cents bigint NOT NULL DEFAULT 0, deduction_cents bigint NOT NULL DEFAULT 0, net_cents bigint NOT NULL DEFAULT 0,
  hold_reason text CHECK (hold_reason IS NULL OR length(hold_reason) <= 500),
  employment_type text,
  approved_by uuid, approved_at timestamptz, sent_at timestamptz, paid_at timestamptz,
  method text, payment_ref text CHECK (payment_ref IS NULL OR length(payment_ref) <= 200), failure_note text CHECK (failure_note IS NULL OR length(failure_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, driver_id), UNIQUE (id, org_id),
  FOREIGN KEY (run_id, org_id) REFERENCES portal_payout_runs (id, org_id) ON DELETE CASCADE
);
CREATE INDEX portal_payouts_driver ON portal_payouts (org_id, driver_id, to_date DESC);

CREATE TABLE portal_pay_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL, trip_id uuid, payout_id uuid,
  kind text NOT NULL CHECK (kind IN ('earning','addon','tip','toll','bonus','deduction','adjustment')),
  key text NOT NULL DEFAULT '', label text NOT NULL CHECK (length(label) BETWEEN 1 AND 300),
  amount_cents bigint NOT NULL,                       -- signed: deductions are negative, so SUM(amount_cents) is the net
  rate_version_id uuid, line_date date NOT NULL,
  source text NOT NULL DEFAULT 'rate' CHECK (source IN ('rate','bonus','deduction','manual','dispute')),
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  ref_id uuid,                                         -- the bonus rule or deduction this came from
  approval text NOT NULL DEFAULT 'approved' CHECK (approval IN ('pending','approved','rejected')),   -- manual adjustments wait for a second person
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  FOREIGN KEY (payout_id, org_id) REFERENCES portal_payouts (id, org_id)
);
CREATE INDEX portal_pay_lines_driver ON portal_pay_lines (org_id, driver_id, line_date);
CREATE INDEX portal_pay_lines_trip ON portal_pay_lines (org_id, trip_id);
CREATE INDEX portal_pay_lines_payout ON portal_pay_lines (org_id, payout_id);

CREATE TABLE portal_bonus_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('trip_count','on_time','rating','peak','busy_zone','referral','safety','streak','tiered','manual')),
  amount_cents bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  period text NOT NULL DEFAULT 'week' CHECK (period IN ('week','month')),
  active boolean NOT NULL DEFAULT true,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);

CREATE TABLE portal_deductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('vehicle_share','fuel_advance','fine','damage','equipment','phone','loan','other')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  total_cents bigint NOT NULL CHECK (total_cents > 0),
  per_payout_cents bigint NOT NULL CHECK (per_payout_cents > 0),
  taken_cents bigint NOT NULL DEFAULT 0 CHECK (taken_cents >= 0),
  recurring boolean NOT NULL DEFAULT false,             -- a fee taken every payout until cancelled (taken_cents keeps counting)
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','active','done','cancelled')),
  attachment_id uuid,
  created_by uuid, approved_by uuid, approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE INDEX portal_deductions_driver ON portal_deductions (org_id, driver_id, status);

CREATE TABLE portal_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payout_id uuid NOT NULL, line_id uuid, driver_id uuid NOT NULL,
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  reply text CHECK (reply IS NULL OR length(reply) <= 1000),
  fix_line_id uuid, resolved_by uuid, resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (payout_id, org_id) REFERENCES portal_payouts (id, org_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['portal_rate_cards','portal_rate_versions','rate_card_assignments','portal_payout_runs','portal_payouts','portal_pay_lines','portal_bonus_rules','portal_deductions','portal_disputes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
