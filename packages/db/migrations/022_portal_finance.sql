-- Owner Portal, phase 5: budgets per cost type (whole cents). `month` empty means "every month"; a row for one month overrides it.
CREATE TABLE portal_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('driver_pay','fuel','maintenance','insurance','finance','tires','fines','other','total')),
  month date CHECK (month IS NULL OR extract(day FROM month) = 1),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (org_id, category, month)
);
ALTER TABLE portal_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_budgets
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
