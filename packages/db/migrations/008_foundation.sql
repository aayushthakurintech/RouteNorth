-- Phase 1 foundation: more roles and locales, custom roles, audit log, branding/settings, user preferences.

-- Wider role and locale lists (Postgres names inline CHECK constraints <table>_<column>_check).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner','admin','dispatcher','manager','driver','customer','viewer'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_locale_check;
ALTER TABLE users ADD CONSTRAINT users_locale_check CHECK (locale IN ('en','fr','pa','ar'));
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_locale_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_locale_check CHECK (locale IN ('en','fr','pa','ar'));

ALTER TABLE users ADD COLUMN display_name text;
ALTER TABLE users ADD COLUMN disabled_at timestamptz;

-- Organization branding (white label) and settings.
ALTER TABLE organizations ADD COLUMN brand_name text;
ALTER TABLE organizations ADD COLUMN brand_color text CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-fA-F]{6}$');
ALTER TABLE organizations ADD COLUMN logo_data_url text CHECK (logo_data_url IS NULL OR length(logo_data_url) <= 400000);
ALTER TABLE organizations ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Custom roles with fine-grained permissions (a list of permission strings, see packages/shared/src/permissions.ts).
CREATE TABLE custom_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  permissions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, name)
);
ALTER TABLE users ADD COLUMN custom_role_id uuid;
ALTER TABLE users ADD CONSTRAINT users_custom_role_fk
  FOREIGN KEY (custom_role_id, org_id) REFERENCES custom_roles (id, org_id) ON DELETE SET NULL (custom_role_id);

-- Per-user interface preferences: favorites, saved views, onboarding progress, theme.
CREATE TABLE user_prefs (
  user_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);

-- Audit log: one row per change, written by the API. Rows cannot be changed or deleted by the app role.
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  actor_label text,
  action text NOT NULL,
  entity text,
  entity_id text,
  method text,
  path text,
  status int,
  detail jsonb,
  ip text
);
CREATE INDEX audit_org_at ON audit_log (org_id, at DESC);
CREATE INDEX audit_entity ON audit_log (org_id, entity, entity_id);

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('routenorth.audit_purge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'audit_log rows cannot be changed or deleted';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['custom_roles','user_prefs','audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- The login lookup also reports whether the account is disabled.
DROP FUNCTION find_login(text);
CREATE FUNCTION find_login(p_email text)
RETURNS TABLE (user_id uuid, org_id uuid, password_hash text, role text, locale text, disabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.org_id, u.password_hash, u.role, u.locale, (u.disabled_at IS NOT NULL)
  FROM users u WHERE lower(u.email) = lower(p_email)
$$;
REVOKE ALL ON FUNCTION find_login(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION find_login(text) TO routenorth_app;
  END IF;
END $$;
