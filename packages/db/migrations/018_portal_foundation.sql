-- Owner Portal, phase 1: foundation.
-- Adds the accountant role, old/new values on the audit log, and change requests (a second person approves a risky change).
-- Nothing here changes or removes existing data.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner','admin','dispatcher','manager','accountant','driver','customer','viewer'));
ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_role_check;
ALTER TABLE invites ADD CONSTRAINT invites_role_check
  CHECK (role IN ('admin','dispatcher','manager','accountant','driver','customer','viewer'));

-- The audit log keeps its old rows as they are. New domain rows also say what the value was before and after.
-- (The immutability trigger from 008 still blocks UPDATE and DELETE, so these columns can only be written on insert.)
ALTER TABLE audit_log
  ADD COLUMN old_value jsonb,
  ADD COLUMN new_value jsonb,
  ADD COLUMN item_label text,
  ADD COLUMN sensitive boolean NOT NULL DEFAULT false;
CREATE INDEX audit_sensitive ON audit_log (org_id, at DESC) WHERE sensitive;

-- "Change requests": the first person asks, a second person with the right permission approves or rejects.
-- Used for big pay rate changes and, later, other sensitive edits. The proposed change is stored, not applied, until approved.
CREATE TABLE change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('rate_card_activation','rate_card_change','payout_approval','bank_details')),
  entity text NOT NULL,
  entity_id uuid NOT NULL,
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
  proposed jsonb NOT NULL DEFAULT '{}'::jsonb,
  current jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by uuid, requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid, decided_at timestamptz, decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_requests_open ON change_requests (org_id, status, created_at DESC);
CREATE UNIQUE INDEX change_requests_one_open ON change_requests (org_id, kind, entity_id) WHERE status = 'pending';

-- Row-Level Security, like every other table.
ALTER TABLE change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON change_requests
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
