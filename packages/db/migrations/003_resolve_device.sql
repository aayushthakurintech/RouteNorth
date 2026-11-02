-- The ingest service must find which organization owns a device before it can set
-- app.org_id, but RLS hides every row until then. This narrow SECURITY DEFINER
-- function is the only way around RLS: it returns just (device_id, org_id) for one
-- registered device. Unregistered devices return no row, so unknown IMEIs are dropped.
CREATE OR REPLACE FUNCTION resolve_device(p_source text, p_external_id text)
RETURNS TABLE (device_id uuid, org_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.org_id FROM devices d
  WHERE d.source = p_source AND d.external_id = p_external_id
$$;
REVOKE ALL ON FUNCTION resolve_device(text, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION resolve_device(text, text) TO routenorth_app;
  END IF;
END $$;
