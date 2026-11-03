# Operating RouteNorth

For whoever runs the service: backups, incidents, and the few settings that matter in production.

## Settings

| Variable | Why it matters |
| --- | --- |
| `JWT_SECRET` | Signs sign-in tokens. 32+ characters. Changing it signs everyone out. |
| `ENCRYPTION_KEY` | Encrypts two-factor secrets in the database (AES-256-GCM). When unset, `JWT_SECRET` is used. Set it separately in production, and keep a copy: **if it is lost, everyone with two-factor on must be reset** (Settings, Security, "Reset two-factor" for a person). |
| `SUPPORT_EMAIL` | Where messages from Help and feedback are emailed. Without it they are still stored (see `support_requests`) and shown to managers. Needs the email provider settings in the README. |
| `WEB_ORIGIN`, `PUBLIC_WEB_URL` | The web address, for cross-origin access and for links in emails. |
| `ADMIN_DATABASE_URL` | A privileged database URL, used only for tasks that cross organizations (health checks, retention). |

## Backups

```bash
pnpm backup                              # backups/routenorth-<UTC time>.dump
pnpm backup /safe/place/nightly.dump     # a chosen file
```

It uses `ADMIN_DATABASE_URL` (or `DATABASE_URL`) and needs `pg_dump` on the PATH. The script checks the file can be read back before it reports success. The `backups/` folder is ignored by git.

Restore into an **empty** database, never over a live one:

```bash
createdb routenorth_restore
RESTORE_DATABASE_URL=postgresql://postgres:…@host/routenorth_restore pnpm restore backups/routenorth-….dump
```

The script refuses a database that already has tables. After a restore, run `pnpm seed` once if the `routenorth_app` role needs its privileges again, and point the API at the restored database.

What this does and does not give you:

- It is a **manual, one-command** backup. Scheduling is yours: run it from cron or your host's scheduler (for example nightly), copy the file off the server, and keep a few generations.
- If your host (Canadian region managed Postgres, for example) offers point-in-time recovery, use that as well. It is better than a nightly dump.
- **Test a restore** every quarter into a scratch database. A backup that was never restored is a guess.
- Files (proof photos and signatures) are stored inside the database, so they are in the dump.

## Status page and incidents

`/status` shows whether the application and database answer, and lists incidents from the last 90 days. Incidents are written by hand:

```sql
-- Start one. level: info | minor | major.  status: investigating | monitoring | resolved
INSERT INTO service_incidents (title, body, level, status)
VALUES ('Map updates are delayed', 'GPS positions arrive a few minutes late. We are working on it.', 'minor', 'investigating');

-- Update it, then resolve it
UPDATE service_incidents SET status = 'monitoring', body = 'Fix deployed, watching.' WHERE id = '…';
UPDATE service_incidents SET status = 'resolved', resolved_at = now() WHERE id = '…';
```

Run these as the admin database user (the app role can only read the table). An open `major` incident turns the page to "major outage", an open `minor` one to "degraded".

## Roadmap

`/roadmap` is read from `roadmap_items` (statuses `considering`, `planned`, `building`, `shipped`; English and French text). Edit it the same way, as the admin user. Votes are counted per person, and shown as a number only.

## Housekeeping that runs by itself

Once a day the API deletes, per organization: GPS positions older than its retention days, messages older than its message retention (0 keeps them), notifications older than 90 days, error records older than 30 days, usage counts older than 400 days, and sessions revoked more than 30 days ago.

## Health

Settings, Health shows the live state for the signed-in organization: database delay, how fresh the GPS feed is, silent devices, failed or stuck webhooks, failed customer messages and workflow runs, recent server errors (paths and messages only, never request bodies), and whether email, SMS and the address lookup are configured. Operators who need cross-organization monitoring should watch `/public/system-status` and the API logs from outside.

## Deleting an organization or a person

Owners can export all data as JSON, erase one person (their email and name are replaced, their sign-in and personal settings are removed, and the account is disabled; trips stay, and audit log entries keep the name that was recorded at the time, because the audit log is append-only), or delete the whole organization from Settings, Security, Data. Deleting an organization removes everything, including its audit log, and cannot be undone: take a backup first if there is any doubt.
