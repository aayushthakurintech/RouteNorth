#!/usr/bin/env bash
# Back up the RouteNorth database to one compressed file.
#   pnpm backup                      -> backups/routenorth-<timestamp>.dump
#   pnpm backup path/to/file.dump    -> that file
# Uses ADMIN_DATABASE_URL, then DATABASE_URL. Needs pg_dump on the PATH.
set -euo pipefail
url="${ADMIN_DATABASE_URL:-${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/routenorth}}"
out="${1:-backups/routenorth-$(date -u +%Y%m%dT%H%M%SZ).dump}"
mkdir -p "$(dirname "$out")"
pg_dump --format=custom --no-owner --no-privileges --dbname="$url" --file="$out"
# A backup you have not looked inside is a hope, not a backup.
pg_restore --list "$out" > /dev/null
echo "Backup written: $out ($(du -h "$out" | cut -f1))"
