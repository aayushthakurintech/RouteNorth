-- A route link used to show every stop on the route (names, places, times) to anyone holding it.
-- Now a link can be tied to one stop (the customer's own) or explicitly allowed to show them all.
-- A route link with neither shows only how far along the route is, with no names or places.
ALTER TABLE share_links ADD COLUMN stop_id uuid, ADD COLUMN all_stops boolean NOT NULL DEFAULT false;

DROP FUNCTION resolve_share(text);
CREATE FUNCTION resolve_share(p_hash text)
RETURNS TABLE (org_id uuid, device_id uuid, route_id uuid, label text, expires_at timestamptz, stop_id uuid, all_stops boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.org_id, s.device_id, s.route_id, s.label, s.expires_at, s.stop_id, s.all_stops FROM share_links s
  WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > now()
$$;
REVOKE ALL ON FUNCTION resolve_share(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION resolve_share(text) TO routenorth_app;
  END IF;
END $$;
