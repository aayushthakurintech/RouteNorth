-- State the arrival/departure detector needs between GPS fixes, plus route timing.
ALTER TABLE organizations ADD COLUMN timezone text NOT NULL DEFAULT 'America/Toronto';
ALTER TABLE stops ADD COLUMN inside_since timestamptz;   -- first fix of the current stay inside the stop's radius
ALTER TABLE stops ADD COLUMN outside_since timestamptz;  -- first fix outside the departure radius after arriving
ALTER TABLE routes ADD COLUMN started_at timestamptz;
ALTER TABLE routes ADD COLUMN completed_at timestamptz;
