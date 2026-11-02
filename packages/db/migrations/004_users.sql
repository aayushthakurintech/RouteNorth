CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','dispatcher','driver','viewer')),
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','fr')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Login must find a user before the organization is known, so like resolve_device this is
-- a narrow SECURITY DEFINER lookup: one row by email, nothing else is exposed.
CREATE OR REPLACE FUNCTION find_login(p_email text)
RETURNS TABLE (user_id uuid, org_id uuid, password_hash text, role text, locale text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.org_id, u.password_hash, u.role, u.locale FROM users u WHERE lower(u.email) = lower(p_email)
$$;
REVOKE ALL ON FUNCTION find_login(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION find_login(text) TO routenorth_app;
  END IF;
END $$;
