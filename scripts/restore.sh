#!/usr/bin/env bash
# Restore a backup made by `pnpm backup` into an EMPTY database.
#   pnpm restore backups/routenorth-<timestamp>.dump
# Target: RESTORE_DATABASE_URL (required, so a restore can never hit production by accident).
set -euo pipefail
file="${1:?usage: pnpm restore <file.dump>}"
url="${RESTORE_DATABASE_URL:?set RESTORE_DATABASE_URL to the empty database to restore into}"
[ -f "$file" ] || { echo "No such file: $file" >&2; exit 1; }
count=$(psql "$url" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
if [ "$count" != "0" ]; then echo "Refusing: the target database already has $count tables. Restore into an empty database." >&2; exit 1; fi
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$url" "$file"
echo "Restored $file. Now check: psql \"\$RESTORE_DATABASE_URL\" -c 'SELECT count(*) FROM organizations'"
