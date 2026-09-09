#!/bin/sh
# Nightly Postgres basebackup → GCS. Runs from cron on the VM.
#
# Retention: last 14 basebackups. WAL segments live in the same bucket
# under wal/; older-than-14-day WAL is pruned by a GCS lifecycle rule.
#
# The basebackup uses the streaming protocol so WAL required to make the
# backup consistent is included in the archive. Restore procedure:
#   1. Provision a new empty data disk on the target VM.
#   2. gsutil cp of the latest basebackup, tar -xzf into the data dir.
#   3. Set restore_command = 'gsutil cp gs://…/wal/%f %p' in recovery.conf.
#   4. Start Postgres; it will replay WAL to the latest archived segment.

set -eu

: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET must be set}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LABEL="cred-basebackup-${STAMP}"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# Basebackup into the local stage dir. -F t writes a single tar.
docker exec cred-postgres pg_basebackup \
    --username "$POSTGRES_USER" \
    --pgdata=- \
    --wal-method=fetch \
    --format=tar \
    --gzip \
    --label="$LABEL" \
    > "$STAGE/basebackup.tar.gz"

# Push to GCS.
gsutil -q cp "$STAGE/basebackup.tar.gz" \
    "gs://${BACKUP_BUCKET}/basebackup/${STAMP}.tar.gz"

# Prune anything older than 14 basebackups.
gsutil ls "gs://${BACKUP_BUCKET}/basebackup/" \
    | sort -r \
    | tail -n +15 \
    | xargs -r -I {} gsutil -q rm {}

echo "postgres backup ok stamp=${STAMP}"
