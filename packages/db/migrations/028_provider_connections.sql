-- Pull connectors: RouteNorth signs in to a company's own GPS provider account (Geotab, Samsara) and pulls positions,
-- for providers that cannot push to a web address. Credentials are stored encrypted (AES-256-GCM, key from
-- ENCRYPTION_KEY or JWT_SECRET); the database alone cannot read them.

CREATE TABLE IF NOT EXISTS provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('geotab','samsara')),
  name text NOT NULL,
  -- Settings that are not secret: Geotab server, database and user name; Samsara region.
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_enc text NOT NULL,
  -- Where the next pull starts: Geotab feed version, Samsara page cursor.
  cursor text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','error','paused')),
  last_sync_at timestamptz,
  last_data_at timestamptz,
  last_error text,
  failures int NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_connections_due ON provider_connections (next_run_at) WHERE status <> 'paused';
ALTER TABLE provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON provider_connections;
CREATE POLICY tenant_isolation ON provider_connections
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- The ingest worker needs to know which companies have a pull due without being able to read anyone's rows.
-- This returns ids only; the worker then reads each connection inside that company (withOrg).
CREATE OR REPLACE FUNCTION due_provider_connections(p_limit int)
RETURNS TABLE (id uuid, org_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.org_id FROM provider_connections c
  WHERE c.status <> 'paused' AND c.next_run_at <= now()
  ORDER BY c.next_run_at LIMIT greatest(1, least(p_limit, 100))
$$;
REVOKE ALL ON FUNCTION due_provider_connections(int) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON provider_connections TO routenorth_app;
    GRANT EXECUTE ON FUNCTION due_provider_connections(int) TO routenorth_app;
  END IF;
END $$;
