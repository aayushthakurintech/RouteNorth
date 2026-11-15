#!/usr/bin/env bash
# Nightly backup of the bundled database. Run from cron on the server:
#   0 3 * * *  /opt/routenorth/deploy/backup.sh >> /var/log/routenorth-backup.log 2>&1
# Writes /var/backups/routenorth/routenorth-<UTC time>.dump, checks it can be read back, and keeps the newest 14.
# Copy the folder somewhere off the server too (see docs/DEPLOY_CANADA.md). A backup that lives only on the same disk is not enough.
set -euo pipefail
cd "$(dirname "$0")"
dir="${BACKUP_DIR:-/var/backups/routenorth}"
mkdir -p "$dir"
out="$dir/routenorth-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose --env-file .env -f docker-compose.yml --profile bundled-db exec -T db \
  pg_dump -U postgres --format=custom --no-owner --no-privileges routenorth > "$out"
docker compose --env-file .env -f docker-compose.yml --profile bundled-db exec -T db pg_restore --list < "$out" > /dev/null
ls -1t "$dir"/routenorth-*.dump | tail -n +15 | xargs -r rm --
echo "Backup written: $out ($(du -h "$out" | cut -f1))"
