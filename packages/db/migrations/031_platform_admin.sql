-- Platform admin console: RouteNorth's own staff, per-client entitlements, suspension, "view as client", and an audit log of staff actions.
--
-- Everything staff-only sits behind a row-level policy that opens only when a transaction says app.platform = 'on'
-- (the API does that in one place, withPlatform). A client's session sets app.org_id and never app.platform, so a
-- client cannot read or write these tables even through a bug in a tenant query. This is a second lock behind the
-- API's own checks, not a replacement for them.

-- ------------------------------------------------------------------------------------------------ clients
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_status_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_status_check CHECK (status IN ('active','suspended'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_reason text CHECK (suspended_reason IS NULL OR length(suspended_reason) <= 500);
-- Staff-only notes about the client. Never returned by a tenant endpoint (they all name their columns).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS internal_notes text CHECK (internal_notes IS NULL OR length(internal_notes) <= 4000);

-- Staff can see and edit every client row, but only inside a withPlatform transaction. Policies are OR-ed with the tenant one.
DROP POLICY IF EXISTS staff_all ON organizations;
CREATE POLICY staff_all ON organizations USING (current_setting('app.platform', true) = 'on') WITH CHECK (current_setting('app.platform', true) = 'on');

-- ------------------------------------------------------------------------------------------------ entitlements
-- No row = the client has every section (all clients that existed before this table). A row with a list of sections = only those
-- (plus the always-on core). `limits` holds hard limits staff set by hand, for example {"vehicles": 25, "users": 5}.
CREATE TABLE IF NOT EXISTS org_entitlements (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  sections text[] NOT NULL,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE org_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_entitlements FORCE ROW LEVEL SECURITY;
-- A client's session may READ its own row (the guard needs it); only staff may write.
DROP POLICY IF EXISTS tenant_read ON org_entitlements;
CREATE POLICY tenant_read ON org_entitlements FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.platform', true) = 'on');
DROP POLICY IF EXISTS staff_write ON org_entitlements;
CREATE POLICY staff_write ON org_entitlements FOR ALL
  USING (current_setting('app.platform', true) = 'on') WITH CHECK (current_setting('app.platform', true) = 'on');

-- ------------------------------------------------------------------------------------------------ staff accounts
CREATE TABLE IF NOT EXISTS platform_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (length(email) <= 200),
  display_name text CHECK (display_name IS NULL OR length(display_name) <= 80),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('super_admin','account_manager','support','auditor')),
  -- Two-factor is not optional for staff. totp_secret is stored encrypted (same envelope as client secrets).
  totp_secret text NOT NULL,
  last_step bigint,
  recovery_hashes text[] NOT NULL DEFAULT '{}',
  must_change_password boolean NOT NULL DEFAULT false,
  -- Extra network limit for this person, on top of the platform-wide PLATFORM_ADMIN_IP_ALLOWLIST. Empty means no extra limit.
  ip_allow_list text[] NOT NULL DEFAULT '{}',
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  disabled_at timestamptz,
  last_login_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_admins_email_lower ON platform_admins (lower(email));

CREATE TABLE IF NOT EXISTS platform_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Set when the person re-enters a code for a sensitive action; sensitive actions need it to be recent.
  stepped_up_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS platform_sessions_admin ON platform_sessions (admin_id, created_at DESC);

-- "View as client". Always read-only, always short, always with a reason the client can see.
CREATE TABLE IF NOT EXISTS platform_impersonations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES platform_admins(id),
  admin_session_id uuid REFERENCES platform_sessions(id),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  ticket text CHECK (ticket IS NULL OR length(ticket) <= 80),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  ended_by text,
  requests int NOT NULL DEFAULT 0,
  blocked_writes int NOT NULL DEFAULT 0,
  -- The distinct pages (API paths without ids) that were read, so the client can see what staff looked at. Capped.
  paths text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS platform_impersonations_org ON platform_impersonations (org_id, started_at DESC);

-- Every staff action. Append-only: updates and deletes are refused, like the client audit log.
CREATE TABLE IF NOT EXISTS platform_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  admin_id uuid,
  admin_email text,
  action text NOT NULL,
  org_id uuid,
  org_name text,
  target text,
  reason text,
  detail jsonb,
  status int,
  ip text,
  session_id uuid
);
CREATE INDEX IF NOT EXISTS platform_audit_at ON platform_audit (at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_org ON platform_audit (org_id, at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_admin ON platform_audit (admin_id, at DESC);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT USAGE, SELECT ON SEQUENCE platform_audit_id_seq TO routenorth_app;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION platform_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit rows cannot be changed or deleted';
END $$;
DROP TRIGGER IF EXISTS platform_audit_no_change ON platform_audit;
CREATE TRIGGER platform_audit_no_change BEFORE UPDATE OR DELETE ON platform_audit FOR EACH ROW EXECUTE FUNCTION platform_audit_immutable();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_admins','platform_sessions','platform_impersonations','platform_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS staff_only ON %I', t);
    EXECUTE format($p$CREATE POLICY staff_only ON %I USING (current_setting('app.platform', true) = 'on') WITH CHECK (current_setting('app.platform', true) = 'on')$p$, t);
  END LOOP;
END $$;

-- A client user and a staff account may not share an email: the sign-in form is the same, so it would be ambiguous.
CREATE OR REPLACE FUNCTION users_not_staff() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_admins a WHERE lower(a.email) = lower(NEW.email)) THEN
    RAISE EXCEPTION 'that email is not available' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS users_not_staff_check ON users;
CREATE TRIGGER users_not_staff_check BEFORE INSERT OR UPDATE OF email ON users FOR EACH ROW EXECUTE FUNCTION users_not_staff();

-- ------------------------------------------------------------------------------------------------ monitoring
-- One row per client with the numbers the console shows. Needs app.platform = 'on', otherwise it returns nothing.
-- A device is "live" if it reported in the last 15 minutes, "recent" if in the last 24 hours, otherwise silent.
CREATE OR REPLACE FUNCTION platform_org_stats()
RETURNS TABLE (org_id uuid, vehicles int, devices int, devices_live int, devices_recent int, users int, drivers int, last_position_at timestamptz, last_login_at timestamptz, jobs_month int, owner_email text, owner_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('app.platform', true) IS DISTINCT FROM 'on' THEN RETURN; END IF;
  RETURN QUERY
  SELECT o.id,
    (SELECT count(*)::int FROM vehicles v WHERE v.org_id = o.id AND v.status <> 'retired'),
    (SELECT count(*)::int FROM devices d WHERE d.org_id = o.id),
    (SELECT count(*)::int FROM latest_positions p WHERE p.org_id = o.id AND p.time > now() - interval '15 minutes'),
    (SELECT count(*)::int FROM latest_positions p WHERE p.org_id = o.id AND p.time > now() - interval '24 hours'),
    (SELECT count(*)::int FROM users u WHERE u.org_id = o.id AND u.disabled_at IS NULL AND u.role NOT IN ('customer','driver')),
    (SELECT count(*)::int FROM users u WHERE u.org_id = o.id AND u.disabled_at IS NULL AND u.role = 'driver'),
    (SELECT max(p.time) FROM latest_positions p WHERE p.org_id = o.id),
    (SELECT max(s.created_at) FROM user_sessions s WHERE s.org_id = o.id),
    (SELECT count(*)::int FROM jobs j WHERE j.org_id = o.id AND j.created_at >= date_trunc('month', now())),
    (SELECT u.email FROM users u WHERE u.org_id = o.id AND u.role = 'owner' AND u.disabled_at IS NULL ORDER BY u.created_at LIMIT 1),
    (SELECT u.display_name FROM users u WHERE u.org_id = o.id AND u.role = 'owner' AND u.disabled_at IS NULL ORDER BY u.created_at LIMIT 1)
  FROM organizations o;
END $$;
REVOKE ALL ON FUNCTION platform_org_stats() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION platform_org_stats() TO routenorth_app;
  END IF;
END $$;

-- Which client holds a tracker ID. Support needs this to settle "two companies claim the same IMEI" without reading any client's devices.
CREATE OR REPLACE FUNCTION platform_find_device(p_source text, p_external_id text)
RETURNS TABLE (org_id uuid, org_name text, device_id uuid, connection_method text, registered_at timestamptz, last_position_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('app.platform', true) IS DISTINCT FROM 'on' THEN RETURN; END IF;
  RETURN QUERY
  SELECT d.org_id, o.name, d.id, d.connection_method, d.created_at, (SELECT p.time FROM latest_positions p WHERE p.device_id = d.id)
  FROM devices d JOIN organizations o ON o.id = d.org_id WHERE d.source = p_source AND d.external_id = p_external_id;
END $$;
REVOKE ALL ON FUNCTION platform_find_device(text, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION platform_find_device(text, text) TO routenorth_app;
  END IF;
END $$;
