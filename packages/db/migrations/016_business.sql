-- Phase 6b: teams, invites, comments, tasks, schedules, plans, rate cards, quotes, budgets and contracts.

-- ---- plan and trial -------------------------------------------------------------------------------------------
ALTER TABLE organizations ADD COLUMN plan text NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial','starter','pro','enterprise'));
ALTER TABLE organizations ADD COLUMN trial_ends_at timestamptz NOT NULL DEFAULT (now() + interval '30 days');

-- ---- teams and regions ----------------------------------------------------------------------------------------
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL DEFAULT 'team' CHECK (kind IN ('team','region','depot_group')),
  depot_id uuid,
  color text CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (id, org_id),
  FOREIGN KEY (depot_id, org_id) REFERENCES depots(id, org_id) ON DELETE SET NULL (depot_id)
);
CREATE TABLE team_members (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id, org_id) REFERENCES teams(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id) ON DELETE CASCADE
);
ALTER TABLE vehicles ADD COLUMN team_id uuid;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_team_fk FOREIGN KEY (team_id, org_id) REFERENCES teams(id, org_id) ON DELETE SET NULL (team_id);
ALTER TABLE jobs ADD COLUMN team_id uuid;
ALTER TABLE jobs ADD CONSTRAINT jobs_team_fk FOREIGN KEY (team_id, org_id) REFERENCES teams(id, org_id) ON DELETE SET NULL (team_id);

-- ---- invites (the link carries a secret; only its hash is stored) ---------------------------------------------
CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (length(email) <= 200),
  role text NOT NULL CHECK (role IN ('admin','dispatcher','manager','driver','customer','viewer')),
  team_id uuid,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (team_id, org_id) REFERENCES teams(id, org_id) ON DELETE SET NULL (team_id)
);
CREATE UNIQUE INDEX invites_one_open ON invites (org_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION find_invite(p_hash text)
RETURNS TABLE (invite_id uuid, org_id uuid, email text, role text, team_id uuid, org_name text, brand_name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.org_id, i.email, i.role, i.team_id, o.name, o.brand_name FROM invites i JOIN organizations o ON o.id = i.org_id
  WHERE i.token_hash = p_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
$$;
REVOKE ALL ON FUNCTION find_invite(text) FROM PUBLIC;

-- ---- comments, notifications and tasks -------------------------------------------------------------------------
CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('job','vehicle','driver','invoice','task','incident')),
  entity_id uuid NOT NULL,
  user_id uuid,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  mentions uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz
);
CREATE INDEX comments_entity ON comments (org_id, entity, entity_id, created_at);
CREATE INDEX comments_mentions ON comments USING gin (mentions);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('mention','task','time_off','approval','invite','system')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  link text CHECK (link IS NULL OR length(link) <= 300),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id) ON DELETE CASCADE
);
CREATE INDEX notifications_user ON notifications (org_id, user_id, created_at DESC);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail text CHECK (detail IS NULL OR length(detail) <= 2000),
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  due_on date,
  assignee_id uuid,
  job_id uuid,
  created_by uuid,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (assignee_id, org_id) REFERENCES users(id, org_id) ON DELETE SET NULL (assignee_id)
);
CREATE INDEX tasks_open ON tasks (org_id, status, due_on);

-- ---- shift schedule and time off ------------------------------------------------------------------------------
CREATE TABLE shift_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  vehicle_id uuid,
  note text CHECK (note IS NULL OR length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '24 hours'),
  FOREIGN KEY (driver_id, org_id) REFERENCES users(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (vehicle_id, org_id) REFERENCES vehicles(id, org_id) ON DELETE SET NULL (vehicle_id)
);
CREATE INDEX shift_plans_time ON shift_plans (org_id, starts_at);

CREATE TABLE time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'vacation' CHECK (kind IN ('vacation','sick','personal','other')),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note text CHECK (note IS NULL OR length(note) <= 500),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on AND ends_on - starts_on <= 366),
  FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id) ON DELETE CASCADE
);
CREATE INDEX time_off_range ON time_off (org_id, starts_on);

-- ---- money: rate cards, quotes, budgets, contracts ------------------------------------------------------------
CREATE TABLE rate_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  basis text NOT NULL CHECK (basis IN ('distance','weight','zone','time')),
  base numeric(10,2) NOT NULL DEFAULT 0 CHECK (base >= 0),
  minimum numeric(10,2) NOT NULL DEFAULT 0 CHECK (minimum >= 0),
  tiers jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tiers) = 'array' AND length(tiers::text) <= 5000),
  zones jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(zones) = 'array' AND length(zones::text) <= 5000),
  customer_name text CHECK (customer_name IS NULL OR length(customer_name) <= 120),
  active boolean NOT NULL DEFAULT true,
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number text NOT NULL,
  customer_name text NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 120),
  customer_email text CHECK (customer_email IS NULL OR length(customer_email) <= 200),
  customer_address text CHECK (customer_address IS NULL OR length(customer_address) <= 300),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined','expired')),
  issued_on date NOT NULL DEFAULT current_date,
  valid_until date,
  currency text NOT NULL DEFAULT 'CAD' CHECK (currency ~ '^[A-Z]{3}$'),
  lines jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(lines) = 'array' AND length(lines::text) <= 30000),
  subtotal numeric(12,2) NOT NULL CHECK (subtotal >= 0),
  tax numeric(12,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  tax_lines jsonb NOT NULL DEFAULT '[]',
  total numeric(12,2) NOT NULL CHECK (total >= 0),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
ALTER TABLE invoices ADD COLUMN tax_lines jsonb NOT NULL DEFAULT '[]';
ALTER TABLE invoices ADD COLUMN quote_id uuid;

CREATE TABLE budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  category text NOT NULL CHECK (category IN ('fuel','maintenance','expenses','total')),
  period text NOT NULL DEFAULT 'month' CHECK (period IN ('month','quarter','year')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  vehicle_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vehicle_id, org_id) REFERENCES vehicles(id, org_id) ON DELETE CASCADE
);

CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_name text NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 120),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  starts_on date NOT NULL,
  ends_on date,
  value numeric(12,2) CHECK (value IS NULL OR value >= 0),
  on_time_target_pct numeric(5,2) NOT NULL DEFAULT 95 CHECK (on_time_target_pct BETWEEN 0 AND 100),
  rate_card_id uuid,
  auto_renew boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','terminated')),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  FOREIGN KEY (rate_card_id, org_id) REFERENCES rate_cards(id, org_id) ON DELETE SET NULL (rate_card_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['teams','team_members','invites','comments','notifications','tasks','shift_plans','time_off','rate_cards','quotes','budgets','contracts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION find_invite(text) TO routenorth_app;
  END IF;
END $$;
