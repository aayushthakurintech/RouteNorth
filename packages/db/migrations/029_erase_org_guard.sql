-- erase_organization runs with the owner's rights, so it must only ever delete the company the caller is signed in to.
-- The API now calls it inside withOrg; the function refuses any other organization id.
CREATE OR REPLACE FUNCTION erase_organization(p_org uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM nullif(current_setting('app.org_id', true), '')::uuid THEN
    RAISE EXCEPTION 'erase_organization: organization does not match the current session' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('routenorth.audit_purge', 'on', true);
  DELETE FROM organizations WHERE id = p_org;
  PERFORM set_config('routenorth.audit_purge', 'off', true);
END $$;
REVOKE ALL ON FUNCTION erase_organization(uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
    GRANT EXECUTE ON FUNCTION erase_organization(uuid) TO routenorth_app;
  END IF;
END $$;
