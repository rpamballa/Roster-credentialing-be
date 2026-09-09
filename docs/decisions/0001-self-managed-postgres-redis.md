# ADR-0001 — Self-managed Postgres + Redis on GCE

- **Status:** Accepted
- **Date:** 2026-08-28

## Context

SPEC §2 locks the stack on Postgres 16 (with the `pgmq` extension) and Redis 7.
The default GCP posture would be Cloud SQL + Memorystore — hands-off, HA out
of the box, per-vCPU + per-GB pricing. We chose instead to run both on a
customer-owned GCE VM using the same OCI images the local `docker-compose`
dev stack uses.

## Decision

Postgres and Redis run inside `docker-compose` on GCE VMs we own:

- one `n2d-standard-2` VM (Postgres, tembo `pg16-pgmq` image) with a 200 GB
  SSD data disk mounted at `/var/lib/postgresql/data`
- one `e2-small` VM (Redis 7-alpine) with a 20 GB standard-persistent disk

Both live in a private subnet. Application services (Cloud Run) reach them
via a Serverless VPC Access connector; nothing is public.

Backups are cron jobs on the VM that push to a GCS bucket we own:

- **Postgres** — nightly `pg_basebackup` + continuous WAL archive via
  `archive_command` piping into `gsutil cp`
- **Redis** — nightly RDB snapshot + AOF (fsync every-second)

## Rationale

We deliberately traded a small amount of operational overhead for four
things Cloud SQL / Memorystore can't give us today:

1. **`pgmq` is a first-party extension.** Cloud SQL for PostgreSQL doesn't
   allow the tembo pgmq extension (as of writing). SPEC §2 locks pgmq as
   the queue. Managed Postgres would force a different queue and undo the
   "one less moving part" principle.
2. **Cost floor.** For pilot volume (≤50 workspaces, ≤500 providers) the
   ~$85/mo GCE + disks bill is 3–4× cheaper than the smallest HA Cloud SQL
   Enterprise Plus tier.
3. **Full parameter control.** We tune `shared_buffers`, `wal_level`,
   `max_wal_size`, and connection limits directly. Cloud SQL exposes a
   subset via flags and gates the rest.
4. **Portability.** The same `docker-compose` runs on dev laptops, on the
   staging Mac (`roster-credentialing-deploy`), and on GCE. If we ever move
   to AWS/Azure the migration is a `gcloud compute instances migrate`-shape
   change to whatever they call VMs there, not an application rewrite.

## Consequences

- **We now own uptime.** Restarts, disk resizes, and OS patching are on us.
  Runbook: `docs/runbooks/self-managed-restore.md`.
- **No automatic failover.** The pilot accepts an ~RTO of 15 min for a
  DB-outage event. HA (streaming replica + `pgpool-II` or Patroni) is
  captured as a follow-up ADR to open when volume warrants it.
- **Backups are only as good as their most recent restore drill.** The
  runbook mandates a monthly restore test into a scratch VM.
- **Cloud SQL escape hatch is preserved.** The Postgres client speaks only
  to `postgres://…` — swapping in a Cloud SQL instance is an env-var
  change plus enabling `cloudsql-auth-proxy` in the Cloud Run YAML. No
  application code changes.

## Alternatives considered

- **Cloud SQL for PostgreSQL + Memorystore for Redis** — rejected on pgmq
  incompatibility and cost.
- **AlloyDB** — same pgmq restriction, and its wire protocol quirks
  complicate the pgmq extension boot.
- **Patroni-managed Postgres on GKE** — proper HA but the operational
  surface (etcd, PgBouncer, pod graceful shutdown windows) is a lot for
  the pilot. Revisit at Series-A volume.
- **Sentinel-managed Redis on GKE** — same reasoning. AOF + fast restore
  covers the pilot's session-loss risk (a magic-link redirect at worst).
