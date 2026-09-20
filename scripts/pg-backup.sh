#!/usr/bin/env bash
# Daily logical backup of the AI Commerce Agent Postgres database.
#
# Usage:
#   PGADMIN_URL=postgres://postgres:password@localhost:5432/ai_commerce_agent ./scripts/pg-backup.sh
#   ./scripts/pg-backup.sh                    # reads PGADMIN_URL from .env
#   KEEP_DAYS=14 ./scripts/pg-backup.sh       # prune backups older than 14 days (default: 30)
#
# The output is a gzipped SQL dump written to ./backups/backup-YYYYMMDDHHMMSS.sql.gz.
# Restore:
#   gunzip -c backups/backup-*.sql.gz | psql "$DATABASE_URL"
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

if [[ -z "${PGADMIN_URL:-}" && -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

if [[ -z "${PGADMIN_URL:-}" ]]; then
  echo "PGADMIN_URL is required (superuser/admin DSN). Export it or set it in .env." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

stamp="$(date +%Y%m%d%H%M%S)"
file="$BACKUP_DIR/backup-$stamp.sql.gz"

# --format=custom would be faster to restore, but plain SQL is the most portable
# for disaster recovery and can be piped straight into psql or automated test DBs.
pg_dump --no-owner --no-privileges "$PGADMIN_URL" | gzip -9 > "$file"

echo "backup written: $file"

# Prune old backups.
find "$BACKUP_DIR" -name 'backup-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "pruned backups older than ${KEEP_DAYS} days from $BACKUP_DIR"