-- Driver actions: delivery proofs (photo and signature) and driver notes.
ALTER TABLE stops ADD CONSTRAINT stops_id_org UNIQUE (id, org_id);
ALTER TABLE stops ADD COLUMN driver_notes text;
ALTER TABLE stops ADD COLUMN recipient_name text;

-- Proof files are stored in the database for now (client-side downscaled photos are a few
-- hundred KB). Move to S3-compatible object storage in Canada when volume grows.
CREATE TABLE proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stop_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('photo','signature')),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  size_bytes int NOT NULL CHECK (size_bytes > 0),
  data bytea NOT NULL,
  taken_at timestamptz NOT NULL,
  lat double precision,
  lng double precision,
  created_by uuid,
  -- Chosen by the phone, so a retried upload after a dropped connection is stored once.
  client_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, client_id),
  FOREIGN KEY (stop_id, org_id) REFERENCES stops (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (created_by)
);
CREATE INDEX proofs_stop ON proofs (stop_id);

ALTER TABLE proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON proofs
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
