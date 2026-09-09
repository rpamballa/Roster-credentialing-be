#!/bin/sh
# Restore the credentialing Postgres to a target timestamp.
#
# Usage:
#   ./restore.sh gs://cred-pg-backups/basebackup/20260828T030000Z.tar.gz \
#                "2026-08-28 14:00:00 UTC"
#
# 1. Stops the running container.
# 2. Wipes /var/lib/postgresql/data (dangerous — you accepted this).
# 3. Extracts the basebackup tar into the data dir.
# 4. Writes recovery.signal + restore_command pointing at gs://.../wal/
# 5. Starts Postgres; it replays WAL up to $2 then pauses at PITR target.
# 6. When happy, run `SELECT pg_wal_replay_resume();` then `promote`.

set -eu

BASEBACKUP_URI="${1:?basebackup GCS URI is required}"
TARGET_TIME="${2:-}"

: "${BACKUP_BUCKET:?BACKUP_BUCKET must be set}"
DATA_DIR="/var/lib/postgresql/data"

echo "restore: stopping cred-postgres" >&2
docker compose down postgres

echo "restore: WIPING $DATA_DIR — Ctrl-C in the next 10s to abort" >&2
sleep 10
sudo rm -rf "$DATA_DIR"/*

echo "restore: fetching basebackup" >&2
gsutil cp "$BASEBACKUP_URI" /tmp/basebackup.tar.gz
sudo tar -xzf /tmp/basebackup.tar.gz -C "$DATA_DIR"
rm -f /tmp/basebackup.tar.gz

echo "restore: writing recovery config" >&2
sudo tee "$DATA_DIR/postgresql.auto.conf" >/dev/null <<CONF
restore_command = 'gsutil cp gs://${BACKUP_BUCKET}/wal/%f %p'
CONF

if [ -n "$TARGET_TIME" ]; then
    sudo tee -a "$DATA_DIR/postgresql.auto.conf" >/dev/null <<CONF
recovery_target_time = '$TARGET_TIME'
recovery_target_action = 'pause'
CONF
fi

sudo touch "$DATA_DIR/recovery.signal"
sudo chown -R 999:999 "$DATA_DIR"   # postgres uid in the image

echo "restore: starting Postgres — watch logs, then pg_wal_replay_resume()" >&2
docker compose up -d postgres
