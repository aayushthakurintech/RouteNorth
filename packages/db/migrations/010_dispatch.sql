-- Dispatch: keep a job's status in step with its stop, barcode scans at stops, and a function that lets the
-- scheduler list organizations (the app role can otherwise only see one organization at a time).

CREATE TABLE stop_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stop_id uuid NOT NULL,
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 200),
  scanned_at timestamptz NOT NULL DEFAULT now(),
  scanned_by uuid,
  client_id uuid,
  UNIQUE (org_id, client_id),
  FOREIGN KEY (stop_id, org_id) REFERENCES stops (id, org_id) ON DELETE CASCADE
);
CREATE INDEX stop_scans_stop ON stop_scans (stop_id);
ALTER TABLE stop_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE stop_scans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stop_scans
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- When a stop changes status (driver tap or automatic arrival), its job follows and the change is recorded.
CREATE FUNCTION stops_sync_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_status text;
BEGIN
  IF NEW.job_id IS NULL OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  next_status := CASE NEW.status WHEN 'pending' THEN 'assigned' WHEN 'arrived' THEN 'arrived' WHEN 'done' THEN 'done'
                                  WHEN 'failed' THEN 'failed' WHEN 'skipped' THEN 'failed' END;
  UPDATE jobs SET status = next_status, updated_at = now()
    WHERE id = NEW.job_id AND org_id = NEW.org_id AND status <> 'cancelled' AND status IS DISTINCT FROM next_status;
  IF FOUND THEN
    INSERT INTO job_events (org_id, job_id, kind, detail)
      VALUES (NEW.org_id, NEW.job_id, 'status', jsonb_build_object('status', next_status, 'source', 'stop', 'reason', NEW.failure_reason));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stops_sync_job AFTER UPDATE OF status ON stops FOR EACH ROW EXECUTE FUNCTION stops_sync_job();

-- Used by the background scheduler (recurring routes, document reminders). Returns ids only.
CREATE FUNCTION all_org_ids() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT id FROM organizations $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION all_org_ids() TO routenorth_app;
  END IF;
END $$;
