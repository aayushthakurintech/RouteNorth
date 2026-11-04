-- Owner Portal, phase 6: favourites and pins for reports, comments with mentions, and folders for saved reports.
-- `report_ref` is either a ready-made report id such as 'V2' or the id of a saved report.
CREATE TABLE portal_report_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  report_ref text NOT NULL CHECK (length(report_ref) BETWEEN 1 AND 60),
  favorite boolean NOT NULL DEFAULT false,
  pinned boolean NOT NULL DEFAULT false,
  last_opened_at timestamptz,
  UNIQUE (org_id, user_id, report_ref)
);
CREATE TABLE portal_report_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  report_ref text NOT NULL CHECK (length(report_ref) BETWEEN 1 AND 60),
  author_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  mentions uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX portal_report_comments_ref ON portal_report_comments (org_id, report_ref, created_at);
ALTER TABLE report_defs ADD COLUMN folder text CHECK (folder IS NULL OR length(folder) BETWEEN 1 AND 60);

ALTER TABLE portal_report_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_report_prefs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_report_prefs
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE portal_report_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_report_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_report_comments
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
