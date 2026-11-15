-- Vehicle onboarding: how each tracker reaches RouteNorth, and a way to tell an owner "we have heard from that ID".

-- How this device's data arrives. NULL for devices that were made before this existed (simulator, older feeds).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS connection_method text;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_connection_method_check;
ALTER TABLE devices ADD CONSTRAINT devices_connection_method_check CHECK (connection_method IS NULL OR connection_method IN ('traccar','feed','geotab','samsara'));
-- The saved provider login a pulled device belongs to (Geotab, Samsara). The device stays if the login is removed.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS provider_connection_id uuid REFERENCES provider_connections(id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS registered_by uuid;
CREATE INDEX IF NOT EXISTS devices_vehicle_idx ON devices (vehicle_id) WHERE vehicle_id IS NOT NULL;

-- Messages that reached us from an ID nobody registered, kept by exact ID so the Add vehicle flow can say
-- "a tracker with this ID reached us 4 minutes ago". There is deliberately no way to list this table: the only door
-- is heard_from_unregistered(source, id), which needs the exact ID. Bounded by purge_heard_unregistered().
CREATE TABLE IF NOT EXISTS ingest_unknown_ids (
  source text NOT NULL,
  external_id text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  n bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (source, external_id)
);
CREATE INDEX IF NOT EXISTS ingest_unknown_ids_seen ON ingest_unknown_ids (last_seen);

CREATE OR REPLACE FUNCTION heard_from_unregistered(p_source text, p_external_id text)
RETURNS TABLE (last_seen timestamptz, n bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.last_seen, u.n FROM ingest_unknown_ids u
  WHERE u.source = p_source AND u.external_id = p_external_id AND u.last_seen > now() - interval '7 days'
$$;

-- Keeps the table small: nothing older than 7 days, and never more than 20000 rows (oldest first).
CREATE OR REPLACE FUNCTION purge_heard_unregistered() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM ingest_unknown_ids WHERE last_seen < now() - interval '7 days';
  DELETE FROM ingest_unknown_ids u USING (SELECT source, external_id FROM ingest_unknown_ids ORDER BY last_seen DESC OFFSET 20000) old
   WHERE u.source = old.source AND u.external_id = old.external_id;
$$;

-- Who owns an ID, without letting one company read another's devices. 'free', 'yours' or 'taken'.
CREATE OR REPLACE FUNCTION device_claim_state(p_source text, p_external_id text, p_org uuid)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(
    (SELECT CASE WHEN d.org_id = p_org THEN 'yours' ELSE 'taken' END FROM devices d WHERE d.source = p_source AND d.external_id = p_external_id
       ORDER BY (d.org_id = p_org) DESC LIMIT 1),
    'free')
$$;

-- The only way in. The table itself has row-level security with no policy, so no role except its owner can read or
-- write it directly, whatever it is granted: the application role can only call the functions in this file.
CREATE OR REPLACE FUNCTION record_unregistered(p_source text, p_external_id text, p_n bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO ingest_unknown_ids (source, external_id, n) VALUES (p_source, p_external_id, p_n)
  ON CONFLICT (source, external_id) DO UPDATE SET n = ingest_unknown_ids.n + EXCLUDED.n, last_seen = now()
$$;
ALTER TABLE ingest_unknown_ids ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION heard_from_unregistered(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_unregistered(text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_heard_unregistered() FROM PUBLIC;
REVOKE ALL ON FUNCTION device_claim_state(text, text, uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION record_unregistered(text, text, bigint) TO routenorth_app;
    GRANT EXECUTE ON FUNCTION heard_from_unregistered(text, text) TO routenorth_app;
    GRANT EXECUTE ON FUNCTION purge_heard_unregistered() TO routenorth_app;
    GRANT EXECUTE ON FUNCTION device_claim_state(text, text, uuid) TO routenorth_app;
  END IF;
END $$;
