#!/bin/sh
# Nightly Redis RDB snapshot → GCS. Runs from cron on the VM.
# Retention: last 14 snapshots. AOF gives us the low-RPO layer between
# snapshots; the RDB gives us the durable disaster-recovery layer.

set -eu

: "${REDIS_PASSWORD:?REDIS_PASSWORD must be set}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET must be set}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# Force a fresh snapshot. BGSAVE returns immediately.
docker exec cred-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning BGSAVE

# Wait for RDB write to finish. `LASTSAVE` returns a Unix timestamp; we
# poll until it moves forward.
BEFORE=$(docker exec cred-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning LASTSAVE)
for _ in $(seq 1 60); do
    NOW=$(docker exec cred-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning LASTSAVE)
    [ "$NOW" != "$BEFORE" ] && break
    sleep 2
done

# Ship the RDB file.
gsutil -q cp /data/dump.rdb "gs://${BACKUP_BUCKET}/rdb/${STAMP}.rdb"

# Retain the last 14.
gsutil ls "gs://${BACKUP_BUCKET}/rdb/" \
    | sort -r \
    | tail -n +15 \
    | xargs -r -I {} gsutil -q rm {}

echo "redis backup ok stamp=${STAMP}"
