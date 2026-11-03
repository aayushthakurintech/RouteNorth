-- Phase 6a: API keys, custom fields and statuses, platform tables.

-- API keys, feed links and inbound-email addresses. Only a hash of the key is stored; the key itself is shown once.
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind text NOT NULL DEFAULT 'api' CHECK (kind IN ('api','feed','inbound')),
  scope text NOT NULL DEFAULT 'read' CHECK (scope IN ('read','write')),
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_org ON api_keys (org_id, created_at DESC);

-- A key arrives with no organization attached, so (like find_login) one narrow SECURITY DEFINER lookup finds it.
CREATE OR REPLACE FUNCTION find_api_key(p_hash text)
RETURNS TABLE (key_id uuid, org_id uuid, kind text, scope text, created_by uuid, name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT k.id, k.org_id, k.kind, k.scope, k.created_by, k.name FROM api_keys k
  WHERE k.key_hash = p_hash AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
$$;
REVOKE ALL ON FUNCTION find_api_key(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION find_api_key(text) TO routenorth_app;
  END IF;
END $$;

-- Extra fields the company defines for its own records, and their values.
CREATE TABLE custom_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('job','vehicle','driver','customer','depot')),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  label_fr text CHECK (label_fr IS NULL OR length(label_fr) <= 80),
  type text NOT NULL DEFAULT 'text' CHECK (type IN ('text','number','date','bool','select')),
  options jsonb CHECK (options IS NULL OR (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 50)),
  required boolean NOT NULL DEFAULT false,
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, entity, key)
);

CREATE TABLE custom_values (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('job','vehicle','driver','customer','depot')),
  record_id uuid NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object' AND length(data::text) <= 20000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entity, record_id)
);

-- The company's own job statuses. Each one stands for one of the built-in states so routes, tracking and reports keep working.
CREATE TABLE custom_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  label_fr text CHECK (label_fr IS NULL OR length(label_fr) <= 60),
  base_status text NOT NULL CHECK (base_status IN ('unassigned','assigned','started','arrived','done','failed','cancelled')),
  color text NOT NULL DEFAULT '#64748b' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);
ALTER TABLE jobs ADD COLUMN custom_status text CHECK (custom_status IS NULL OR custom_status ~ '^[a-z][a-z0-9_]{0,39}$');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys','custom_fields','custom_values','custom_statuses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
