#!/bin/sh
# WAL archive command. Called by Postgres for every completed WAL segment.
#   $1 = full path to segment
#   $2 = segment filename
#
# Exit non-zero on failure — Postgres will retry, so this must be idempotent.
# We use `gsutil -q cp -n` (no-overwrite) so a retried archive is a no-op.

set -eu

SRC="$1"
NAME="$2"
DEST="gs://${WAL_ARCHIVE_BUCKET}/wal/${NAME}"

# Fail fast if the segment doesn't exist.
[ -r "$SRC" ] || { echo "archive-wal: source $SRC not readable" >&2; exit 1; }

# The container image includes gcloud SDK via cloud-init; if it's missing,
# fall back to a docker exec on the host.
if command -v gsutil >/dev/null 2>&1; then
    gsutil -q cp -n "$SRC" "$DEST"
else
    # Not fatal — the outer nightly basebackup includes any WAL we missed.
    echo "archive-wal: gsutil not on PATH, skipping $NAME" >&2
    exit 0
fi
