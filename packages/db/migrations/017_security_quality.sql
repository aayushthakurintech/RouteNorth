-- Phase 6c: security (two-factor, sessions, privacy, erase) and quality (support, roadmap, usage, flags, errors).

-- Two-factor sign-in. Kept apart from users so a SELECT on users can never expose the secret. The secret is stored encrypted.
CREATE TABLE user_security (
  user_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  totp_secret text,
  totp_pending text,
  totp_enabled_at timestamptz,
  recovery_hashes text[] NOT NULL DEFAULT '{}',
  last_step bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);

-- One row per signed-in browser or app. A token carries its row id, so revoking the row signs that device out at once.
CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  revoked_at timestamptz,
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);
CREATE INDEX user_sessions_user ON user_sessions (org_id, user_id, created_at DESC);

-- Messages to the product team: questions, bug reports, ideas and praise.
CREATE TABLE support_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid,
  kind text NOT NULL CHECK (kind IN ('question','bug','idea','praise')),
  subject text CHECK (subject IS NULL OR length(subject) <= 160),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  page text CHECK (page IS NULL OR length(page) <= 200),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  reply text CHECK (reply IS NULL OR length(reply) <= 4000),
  replied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE SET NULL (user_id)
);
CREATE INDEX support_requests_org ON support_requests (org_id, created_at DESC);

-- The public roadmap is the same for everyone, so it has no org_id. The app can read it but not change it.
CREATE TABLE roadmap_items (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,60}$'),
  status text NOT NULL CHECK (status IN ('considering','planned','building','shipped')),
  title_en text NOT NULL, title_fr text NOT NULL,
  body_en text NOT NULL DEFAULT '', body_fr text NOT NULL DEFAULT '',
  sort int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO roadmap_items (id, status, title_en, title_fr, body_en, body_fr, sort) VALUES
  ('eld-integration', 'planned', 'Certified ELD integration', 'Intégration d’un ELD certifié', 'Hours of service from a certified ELD provider, shown next to the shift and fatigue tools.', 'Heures de service d’un fournisseur d’ELD certifié, à côté des outils de quarts et de fatigue.', 10),
  ('sso', 'planned', 'Single sign-on (SAML and OpenID Connect)', 'Authentification unique (SAML et OpenID Connect)', 'Sign in with your company identity provider.', 'Connexion avec le fournisseur d’identité de votre entreprise.', 20),
  ('payments', 'considering', 'Card payments and a billing portal', 'Paiements par carte et portail de facturation', 'Pay invoices by card and manage your plan in the app.', 'Payer les factures par carte et gérer votre forfait dans l’appli.', 30),
  ('driver-schedule', 'planned', 'Schedule and time off in the driver app', 'Horaire et congés dans l’appli chauffeur', 'Drivers see their shifts and ask for time off from the phone.', 'Les chauffeurs voient leurs quarts et demandent des congés depuis le téléphone.', 40),
  ('native-apps', 'considering', 'Store-ready mobile apps', 'Applis mobiles prêtes pour les boutiques', 'Packaged iOS and Android apps for drivers.', 'Applis iOS et Android empaquetées pour les chauffeurs.', 50),
  ('team-access', 'considering', 'Teams that limit what people can see', 'Équipes qui limitent ce que les gens voient', 'Restrict a dispatcher to their own region or depot.', 'Limiter un répartiteur à sa région ou à son dépôt.', 60),
  ('driver-app', 'shipped', 'Driver app with offline proof of delivery', 'Appli chauffeur avec preuve de livraison hors ligne', '', '', 5),
  ('smart-dispatch', 'shipped', 'Route optimization and smart dispatch', 'Optimisation des itinéraires et répartition intelligente', '', '', 6);

-- Service incidents, shown on the system status page. Written by the operator (see docs/OPERATIONS.md).
CREATE TABLE service_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text CHECK (body IS NULL OR length(body) <= 2000),
  level text NOT NULL DEFAULT 'minor' CHECK (level IN ('info','minor','major')),
  status text NOT NULL DEFAULT 'investigating' CHECK (status IN ('investigating','monitoring','resolved')),
  started_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX service_incidents_time ON service_incidents (started_at DESC);

CREATE TABLE roadmap_votes (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  item_id text NOT NULL REFERENCES roadmap_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);

-- Product analytics without people: how many times a page or feature was used per day and role. No user id, no content.
CREATE TABLE usage_counts (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('page','feature')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  role text NOT NULL,
  n int NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day, kind, name, role)
);

-- Server errors the API caught, for the health page. No request bodies are stored.
CREATE TABLE error_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  status int NOT NULL,
  method text, path text CHECK (path IS NULL OR length(path) <= 300),
  message text CHECK (message IS NULL OR length(message) <= 500)
);
CREATE INDEX error_log_time ON error_log (org_id, at DESC);

-- How many organizations voted for each roadmap item. A function, because the votes are tenant-isolated.
CREATE FUNCTION roadmap_vote_counts() RETURNS TABLE (item_id text, votes bigint) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT item_id, count(*) FROM roadmap_votes GROUP BY item_id
$$;

-- Delete a whole organization and everything it owns. The audit log may be removed only through this function.
CREATE FUNCTION erase_organization(p_org uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('routenorth.audit_purge', 'on', true);
  DELETE FROM organizations WHERE id = p_org;
  PERFORM set_config('routenorth.audit_purge', 'off', true);
END $$;
REVOKE ALL ON FUNCTION erase_organization(uuid) FROM PUBLIC;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_security','user_sessions','support_requests','roadmap_votes','usage_counts','error_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['roadmap_items','service_incidents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY read_all ON %I FOR SELECT USING (true)', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION roadmap_vote_counts() TO routenorth_app;
    GRANT EXECUTE ON FUNCTION erase_organization(uuid) TO routenorth_app;
  END IF;
END $$;
