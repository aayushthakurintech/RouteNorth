-- Phase 4: automation, the driver app (chat, help, shifts, expenses) and customer-facing features.
-- Every table carries org_id and is protected by Row-Level Security (see the loop at the end).

-- ---------------------------------------------------------------------------------------------------------------
-- A short, readable address for each organization's public pages (/status/acme, /book/acme, /help/acme).
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE organizations ADD COLUMN slug text CHECK (slug IS NULL OR slug ~ '^[a-z0-9][a-z0-9-]{0,48}$');
-- Looks past Row-Level Security: a slug must be unique across all organizations.
CREATE FUNCTION slug_taken(p_slug text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT EXISTS (SELECT 1 FROM organizations WHERE slug = p_slug) $$;
CREATE FUNCTION organizations_set_slug() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base text; candidate text;
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base := trim(both '-' from regexp_replace(lower(coalesce(NEW.brand_name, NEW.name)), '[^a-z0-9]+', '-', 'g'));
  IF base = '' OR base IS NULL THEN base := 'fleet'; END IF;
  base := left(base, 40);
  candidate := base;
  WHILE slug_taken(candidate) LOOP
    candidate := base || '-' || substr(md5(random()::text), 1, 4);
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_set_slug BEFORE INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION organizations_set_slug();
-- Existing organizations get a slug.
DO $$
DECLARE r record; base text; candidate text;
BEGIN
  FOR r IN SELECT id, name, brand_name FROM organizations WHERE slug IS NULL LOOP
    base := left(coalesce(nullif(trim(both '-' from regexp_replace(lower(coalesce(r.brand_name, r.name)), '[^a-z0-9]+', '-', 'g')), ''), 'fleet'), 40);
    candidate := base;
    WHILE slug_taken(candidate) LOOP candidate := base || '-' || substr(md5(random()::text), 1, 4); END LOOP;
    PERFORM set_config('app.org_id', r.id::text, true);
    UPDATE organizations SET slug = candidate WHERE id = r.id;
  END LOOP;
END $$;
ALTER TABLE organizations ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX organizations_slug_key ON organizations (slug);

CREATE FUNCTION resolve_org_slug(p_slug text) RETURNS TABLE (id uuid) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id FROM organizations o WHERE o.slug = lower(p_slug)
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Jobs: price, customer instructions and where the order came from.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE jobs
  ADD COLUMN price numeric(10,2) CHECK (price IS NULL OR price >= 0),
  ADD COLUMN customer_instructions text CHECK (customer_instructions IS NULL OR length(customer_instructions) <= 500),
  ADD COLUMN source text NOT NULL DEFAULT 'office' CHECK (source IN ('office','import','booking','portal','api','email','store','return')),
  ADD COLUMN parent_job_id uuid;

ALTER TABLE driver_profiles ADD COLUMN photo_data_url text CHECK (photo_data_url IS NULL OR (length(photo_data_url) <= 300000 AND photo_data_url ~ '^data:image/(jpeg|png|webp);base64,'));

-- ---------------------------------------------------------------------------------------------------------------
-- The event feed everything else listens to (workflows, webhooks, customer messages).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE automation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (length(kind) BETWEEN 3 AND 60),
  subject_kind text, subject_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz, error text
);
CREATE INDEX automation_events_pending ON automation_events (at) WHERE processed_at IS NULL;
CREATE INDEX automation_events_org_time ON automation_events (org_id, at DESC);

-- Jobs announce themselves: created, and every change of status. Doing it in the database means the office screens,
-- the driver app, imports and the generic editor all produce the same events.
CREATE FUNCTION jobs_emit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO automation_events (org_id, kind, subject_kind, subject_id, payload)
      VALUES (NEW.org_id, 'job.created', 'job', NEW.id, jsonb_build_object('status', NEW.status, 'source', NEW.source));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO automation_events (org_id, kind, subject_kind, subject_id, payload)
      VALUES (NEW.org_id, 'job.' || NEW.status, 'job', NEW.id,
              jsonb_build_object('from', OLD.status, 'status', NEW.status, 'reason', NEW.reason_code, 'routeId', coalesce(NEW.route_id, OLD.route_id)));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_emit_insert AFTER INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_emit();
CREATE TRIGGER jobs_emit_update AFTER UPDATE OF status ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_emit();

-- A stop that leaves a route (a cancellation, a reschedule) is the moment a route may need re-planning.
CREATE FUNCTION stops_emit_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'pending' AND EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) THEN
    INSERT INTO automation_events (org_id, kind, subject_kind, subject_id, payload)
      VALUES (OLD.org_id, 'route.stop_removed', 'route', OLD.route_id, jsonb_build_object('routeId', OLD.route_id, 'jobId', OLD.job_id));
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER stops_emit_removed AFTER DELETE ON stops FOR EACH ROW WHEN (OLD.job_id IS NOT NULL) EXECUTE FUNCTION stops_emit_removed();

-- ---------------------------------------------------------------------------------------------------------------
-- Workflows: when this happens, and these conditions hold, do these things.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 500),
  active boolean NOT NULL DEFAULT true,
  trigger jsonb NOT NULL CHECK (jsonb_typeof(trigger) = 'object'),
  match text NOT NULL DEFAULT 'all' CHECK (match IN ('all','any')),
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conditions) = 'array' AND length(conditions::text) <= 20000),
  actions jsonb NOT NULL CHECK (jsonb_typeof(actions) = 'array' AND length(actions::text) <= 50000),
  run_count int NOT NULL DEFAULT 0, last_run_at timestamptz,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL, event_id uuid,
  dedupe_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','failed','skipped')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, dedupe_key),
  FOREIGN KEY (workflow_id, org_id) REFERENCES workflows (id, org_id) ON DELETE CASCADE
);
CREATE INDEX workflow_runs_time ON workflow_runs (org_id, at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- Webhooks: signed HTTPS calls to another system on any event, retried with a growing delay.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  url text NOT NULL CHECK (length(url) BETWEEN 10 AND 500),
  secret text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL, event_id uuid, kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed')),
  attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status int, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
  FOREIGN KEY (subscription_id, org_id) REFERENCES webhook_subscriptions (id, org_id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_sub ON webhook_deliveries (subscription_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- Approvals: overtime, large expenses and anything a workflow asks a manager to confirm.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('overtime','expense','job','custom')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  subject_kind text, subject_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by uuid, decided_by uuid, decided_at timestamptz, decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX approvals_one_pending ON approvals (org_id, kind, subject_id) WHERE status = 'pending' AND subject_id IS NOT NULL;
CREATE INDEX approvals_org_status ON approvals (org_id, status, created_at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- Messages: one chat thread per driver, and one per customer job.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_kind text NOT NULL CHECK (thread_kind IN ('driver','customer')),
  thread_id uuid NOT NULL,
  sender_kind text NOT NULL CHECK (sender_kind IN ('driver','dispatch','customer','system')),
  sender_id uuid,
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
  quick_key text CHECK (quick_key IS NULL OR length(quick_key) <= 40),
  audio_data_url text CHECK (audio_data_url IS NULL OR length(audio_data_url) <= 900000),
  job_id uuid, stop_id uuid,
  client_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, client_id),
  CHECK (body <> '' OR audio_data_url IS NOT NULL)
);
CREATE INDEX messages_thread ON messages (org_id, thread_kind, thread_id, created_at);

-- ---------------------------------------------------------------------------------------------------------------
-- Help requests from the driver app (flat tire, wrong address, customer not home ...).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE help_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('flat_tire','breakdown','accident','medical','wrong_address','customer_not_home','access_problem','other')),
  note text CHECK (note IS NULL OR length(note) <= 500),
  stop_id uuid, job_id uuid, lat double precision, lng double precision,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  acknowledged_by uuid, acknowledged_at timestamptz, resolved_by uuid, resolved_at timestamptz, resolution text CHECK (resolution IS NULL OR length(resolution) <= 500),
  client_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, client_id)
);
CREATE INDEX help_requests_org_status ON help_requests (org_id, status, created_at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- Timesheets: shifts and breaks.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL,
  started_at timestamptz NOT NULL, ended_at timestamptz,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto','edited')),
  start_lat double precision, start_lng double precision, end_lat double precision, end_lng double precision,
  note text CHECK (note IS NULL OR length(note) <= 500),
  overtime_minutes int NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
  overtime_status text NOT NULL DEFAULT 'none' CHECK (overtime_status IN ('none','pending','approved','rejected')),
  edited_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX shifts_one_open ON shifts (org_id, driver_id) WHERE ended_at IS NULL;
CREATE INDEX shifts_driver_time ON shifts (org_id, driver_id, started_at DESC);
CREATE TABLE shift_breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'break' CHECK (kind IN ('break','lunch')),
  started_at timestamptz NOT NULL, ended_at timestamptz,
  FOREIGN KEY (shift_id, org_id) REFERENCES shifts (id, org_id) ON DELETE CASCADE,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX shift_breaks_one_open ON shift_breaks (shift_id) WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- Expenses captured by drivers (fuel receipts, parking, tolls).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fuel','parking','toll','meal','repair','other')),
  amount numeric(10,2) NOT NULL CHECK (amount > 0 AND amount < 100000),
  tax numeric(10,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  currency text NOT NULL DEFAULT 'CAD' CHECK (currency ~ '^[A-Z]{3}$'),
  spent_on date NOT NULL DEFAULT current_date,
  vehicle_id uuid, litres numeric(8,2) CHECK (litres IS NULL OR litres > 0), odometer_km double precision CHECK (odometer_km IS NULL OR odometer_km >= 0),
  vendor text CHECK (vendor IS NULL OR length(vendor) <= 120), note text CHECK (note IS NULL OR length(note) <= 500),
  receipt_data_url text CHECK (receipt_data_url IS NULL OR length(receipt_data_url) <= 700000),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','reimbursed')),
  decided_by uuid, decided_at timestamptz, decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  fuel_log_id uuid, client_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, client_id)
);
CREATE INDEX expenses_org_time ON expenses (org_id, spent_on DESC);
CREATE INDEX expenses_user ON expenses (org_id, user_id, spent_on DESC);

-- Short tips and training clips the driver app shows.
CREATE TABLE training_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body text CHECK (body IS NULL OR length(body) <= 2000),
  video_url text CHECK (video_url IS NULL OR video_url ~ '^https://'),
  lang text CHECK (lang IS NULL OR lang IN ('en','fr')),
  sort int NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------------------------
-- Customer-facing: links, requests, preferences, notices, templates, invoices.
-- ---------------------------------------------------------------------------------------------------------------
-- A link for the person waiting for one job. The token is derived on the server from the link id, and only its hash is stored.
CREATE TABLE job_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);
CREATE FUNCTION resolve_job_link(p_hash text) RETURNS TABLE (id uuid, org_id uuid, job_id uuid, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT l.id, l.org_id, l.job_id, l.expires_at FROM job_links l WHERE l.token_hash = p_hash AND l.revoked_at IS NULL AND l.expires_at > now()
$$;

CREATE TABLE customer_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reschedule','cancel','return','pickup','instructions','window','message')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','pending','declined')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_requests_job ON customer_requests (org_id, job_id, created_at DESC);

-- What a customer wants to hear about, and how. One row per contact (email address or phone number).
CREATE TABLE customer_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact text NOT NULL CHECK (length(contact) BETWEEN 3 AND 200),
  email_on boolean NOT NULL DEFAULT true, sms_on boolean NOT NULL DEFAULT true,
  muted_events text[] NOT NULL DEFAULT '{}',
  locale text CHECK (locale IS NULL OR locale IN ('en','fr')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, contact)
);

-- Every customer message the system tried to send, once per job, event and channel.
CREATE TABLE customer_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  event text NOT NULL, channel text NOT NULL CHECK (channel IN ('email','sms')),
  to_addr text, subject text,
  status text NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error text, at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, event, channel)
);
CREATE INDEX customer_notifications_org_time ON customer_notifications (org_id, at DESC);

-- An organization's own wording for customer messages (the built-in text is used when there is none).
CREATE TABLE message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event text NOT NULL, channel text NOT NULL CHECK (channel IN ('email','sms')), locale text NOT NULL CHECK (locale IN ('en','fr')),
  subject text CHECK (subject IS NULL OR length(subject) <= 200), body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  UNIQUE (org_id, event, channel, locale)
);

CREATE TABLE counters (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL, n int NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, name)
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number text NOT NULL,
  job_id uuid,
  customer_name text, customer_email text, customer_address text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','void')),
  issued_on date NOT NULL DEFAULT current_date, due_on date,
  currency text NOT NULL DEFAULT 'CAD' CHECK (currency ~ '^[A-Z]{3}$'),
  lines jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lines) = 'array' AND length(lines::text) <= 20000),
  subtotal numeric(12,2) NOT NULL CHECK (subtotal >= 0), tax numeric(12,2) NOT NULL DEFAULT 0 CHECK (tax >= 0), total numeric(12,2) NOT NULL CHECK (total >= 0),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  paid_at timestamptz, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE UNIQUE INDEX invoices_one_per_job ON invoices (org_id, job_id) WHERE job_id IS NOT NULL AND status <> 'void';
CREATE INDEX invoices_customer ON invoices (org_id, lower(customer_email));

CREATE TABLE status_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  level text NOT NULL DEFAULT 'info' CHECK (level IN ('info','minor','major','resolved')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body text CHECK (body IS NULL OR length(body) <= 2000),
  starts_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE faq_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (length(question) BETWEEN 3 AND 300),
  answer text NOT NULL CHECK (length(answer) BETWEEN 1 AND 4000),
  lang text CHECK (lang IS NULL OR lang IN ('en','fr')),
  sort int NOT NULL DEFAULT 0, published boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------------------------
-- New alert kinds: drivers who need a break, and open help requests.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_kind_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_kind_check CHECK (kind IN
  ('late_risk','off_route','long_idle','speeding','geofence','offline','harsh_driving','document_expiry','maintenance_due','cost_anomaly','custom_metric','needs_break','help_request'));

-- Next number in a named sequence for the organization (invoice numbers).
CREATE FUNCTION next_counter(p_org uuid, p_name text) RETURNS int LANGUAGE sql AS $$
  INSERT INTO counters (org_id, name, n) VALUES (p_org, p_name, 1)
  ON CONFLICT (org_id, name) DO UPDATE SET n = counters.n + 1 RETURNING n
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['automation_events','workflows','workflow_runs','webhook_subscriptions','webhook_deliveries','approvals','messages','help_requests',
    'shifts','shift_breaks','expenses','training_items','job_links','customer_requests','customer_prefs','customer_notifications','message_templates','counters',
    'invoices','status_notices','faq_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION slug_taken(text), resolve_org_slug(text), resolve_job_link(text), next_counter(uuid, text) TO routenorth_app;
  END IF;
END $$;
