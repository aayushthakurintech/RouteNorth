-- Share links resolve without a signed-in user, so the lookup is a narrow SECURITY DEFINER function
-- (the same pattern as find_login): it returns only what the public tracking page needs.
CREATE FUNCTION resolve_share(p_hash text)
RETURNS TABLE (org_id uuid, device_id uuid, route_id uuid, label text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.org_id, s.device_id, s.route_id, s.label, s.expires_at FROM share_links s
  WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > now()
$$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION resolve_share(text) TO routenorth_app;
  END IF;
END $$;

-- Business or personal use of a trip, for mileage and tax logs.
CREATE TABLE trip_purposes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  trip_start timestamptz NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('business','personal')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  set_by uuid, set_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, trip_start)
);
ALTER TABLE trip_purposes ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_purposes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON trip_purposes
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE incidents ADD COLUMN reported_by uuid;
