-- Self-service sign-up and password reset.
--
-- Both happen before anyone is signed in, so there is no organization to scope to. Like find_login, each step is one
-- narrow SECURITY DEFINER function; the tables behind them have row-level security on and no policy, so the app role
-- cannot read them directly.

CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user ON password_resets (user_id, created_at DESC);
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;

-- What a person agreed to when they signed up (terms and privacy versions, and marketing email consent kept apart, as CASL requires).
CREATE TABLE signup_consents (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  terms_version text NOT NULL,
  marketing_email boolean NOT NULL DEFAULT false,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip text
);
ALTER TABLE signup_consents ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION signup_organization(p_company text, p_email text, p_hash text, p_name text, p_locale text, p_terms text, p_marketing boolean, p_ip text)
RETURNS TABLE (org_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o uuid; u uuid;
BEGIN
  INSERT INTO organizations (name, locale) VALUES (p_company, p_locale) RETURNING id INTO o;
  INSERT INTO users (org_id, email, password_hash, role, locale, display_name) VALUES (o, p_email, p_hash, 'owner', p_locale, p_name) RETURNING id INTO u;
  INSERT INTO signup_consents (user_id, terms_version, marketing_email, ip) VALUES (u, p_terms, p_marketing, p_ip);
  RETURN QUERY SELECT o, u;
END $$;

-- Starts a reset: older unused links stop working, and the caller gets the person's ids to send the link to. Nothing is returned for an unknown or disabled account.
CREATE FUNCTION start_password_reset(p_email text, p_hash text, p_expires timestamptz)
RETURNS TABLE (user_id uuid, org_id uuid, email text, locale text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  SELECT u.id, u.org_id, u.email, u.locale INTO r FROM users u WHERE lower(u.email) = lower(p_email) AND u.disabled_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE password_resets pr SET used_at = now() WHERE pr.user_id = r.id AND pr.used_at IS NULL;
  INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (r.id, p_hash, p_expires);
  RETURN QUERY SELECT r.id, r.org_id, r.email, r.locale;
END $$;

-- Finishes a reset in one step: the link is used up, the password changes and every signed-in session of that person ends.
CREATE FUNCTION finish_password_reset(p_hash text, p_new_hash text)
RETURNS TABLE (user_id uuid, org_id uuid, email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid;
BEGIN
  UPDATE password_resets pr SET used_at = now()
   WHERE pr.token_hash = p_hash AND pr.used_at IS NULL AND pr.expires_at > now()
   RETURNING pr.user_id INTO uid;
  IF uid IS NULL THEN RETURN; END IF;
  UPDATE users SET password_hash = p_new_hash WHERE id = uid;
  UPDATE user_sessions SET revoked_at = now() WHERE user_sessions.user_id = uid AND revoked_at IS NULL;
  RETURN QUERY SELECT u.id, u.org_id, u.email FROM users u WHERE u.id = uid;
END $$;

REVOKE ALL ON FUNCTION signup_organization(text, text, text, text, text, text, boolean, text), start_password_reset(text, text, timestamptz), finish_password_reset(text, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION signup_organization(text, text, text, text, text, text, boolean, text), start_password_reset(text, text, timestamptz), finish_password_reset(text, text) TO routenorth_app;
  END IF;
END $$;
