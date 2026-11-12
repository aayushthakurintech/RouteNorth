-- Owner Portal, phase 7: alerts and automations.
-- Builds on the alert engine already in place (alert_rules, alerts): adds default rules the owner can edit, people to tell, snooze, assign, a history of who
-- handled each alert, per-person delivery choices, and a record of what each automation did. Nothing existing is removed.

-- ---- rules: where they come from, who they tell, how often a critical one repeats ---------------------------------------------------
ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_kind_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_kind_check CHECK (kind IN
  ('late_risk','off_route','long_idle','speeding','geofence','offline','harsh_driving','document_expiry','maintenance_due','cost_anomaly','custom_metric','needs_break','help_request',
   'fatigue','checkin_missed','crash','budget',
   'vehicle_docs','service_due','inspection_failed','vehicle_idle','fuel_above_normal','repair_over_budget',
   'driver_docs','driver_safety_low','driver_rating_low','driver_overtime','driver_inactive','driver_cancellations','driver_stuck_onboarding',
   'payout_waiting','trip_pay_off','dispute_open','losing_money','invoice_overdue','portal_budget','custom_measure'));
ALTER TABLE alert_rules
  ADD COLUMN area text CHECK (area IS NULL OR area IN ('vehicle','driver','pay','money','custom','live')),
  ADD COLUMN system_key text CHECK (system_key IS NULL OR length(system_key) <= 40),          -- set on the default rules; null on rules the owner made
  ADD COLUMN repeat_minutes int NOT NULL DEFAULT 30 CHECK (repeat_minutes BETWEEN 5 AND 1440), -- a critical alert is sent again this often until someone acts
  ADD COLUMN recipient_ids uuid[] NOT NULL DEFAULT '{}',                                        -- people to tell; empty means the owners and admins
  ADD COLUMN scope_kind text CHECK (scope_kind IS NULL OR scope_kind IN ('company','vehicle','driver')),
  ADD COLUMN scope_id uuid,
  ADD COLUMN description text CHECK (description IS NULL OR length(description) <= 500),
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN updated_by uuid, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX alert_rules_system_key ON alert_rules (org_id, system_key) WHERE system_key IS NOT NULL;

-- ---- alerts: who has it, until when it is snoozed, who closed it ---------------------------------------------------------------------
ALTER TABLE alerts
  ADD COLUMN area text,
  ADD COLUMN assigned_to uuid, ADD COLUMN assigned_at timestamptz,
  ADD COLUMN snoozed_until timestamptz, ADD COLUMN snoozed_by uuid,
  ADD COLUMN resolved_by uuid, ADD COLUMN resolved_at timestamptz, ADD COLUMN resolved_how text CHECK (resolved_how IS NULL OR resolved_how IN ('person','auto')),
  ADD COLUMN last_sent_at timestamptz;
CREATE INDEX alerts_active ON alerts (org_id, last_at DESC) WHERE status <> 'resolved';

-- ---- history: one row for each thing that happened to an alert ----------------------------------------------------------------------
CREATE TABLE alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  alert_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,                                    -- null when the system did it
  kind text NOT NULL CHECK (kind IN ('raised','escalated','sent','repeated','acknowledged','assigned','unassigned','snoozed','unsnoozed','done','reopened','auto_resolved','note')),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX alert_events_alert ON alert_events (alert_id, at);

-- ---- what each person wants to receive ---------------------------------------------------------------------------------------------
CREATE TABLE portal_alert_prefs (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  channels jsonb NOT NULL DEFAULT '{}'::jsonb,       -- { info: ["inapp"], warn: ["inapp","email"], critical: ["inapp","email","sms"] }
  muted_areas text[] NOT NULL DEFAULT '{}',
  quiet_start time, quiet_end time,                  -- critical alerts still come through
  digest boolean NOT NULL DEFAULT true,
  phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- ---- what the automations did (and the guard that stops one from doing the same thing twice) -----------------------------------------------
CREATE TABLE portal_automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  automation text NOT NULL CHECK (length(automation) BETWEEN 1 AND 40),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),   -- what it was done for, for example "payout:<id>"
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','failed','skipped')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, automation, subject)
);
CREATE INDEX portal_automation_runs_time ON portal_automation_runs (org_id, at DESC);

-- ---- a trip whose pay looks wrong is flagged for a person to look at -------------------------------------------------------------------------
ALTER TABLE portal_trips
  ADD COLUMN review_flag text CHECK (review_flag IS NULL OR length(review_flag) <= 300),
  ADD COLUMN flagged_at timestamptz,
  ADD COLUMN reviewed_by uuid, ADD COLUMN reviewed_at timestamptz;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['alert_events','portal_alert_prefs','portal_automation_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
