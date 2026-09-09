# Self-managed Postgres + Redis on GCE

Per [ADR-0001](../../../docs/decisions/0001-self-managed-postgres-redis.md).
Two single-node VMs, docker-compose, backups to GCS, reachable only through
the private VPC. Cloud Run services (api + workers) reach them via a
Serverless VPC Access connector.

## Layout

```
infrastructure/gcp/self-managed/
├── README.md                          # this file
├── postgres/
│   ├── docker-compose.yml             # tembo pg16-pgmq, tuned
│   ├── conf.d/postgresql.conf         # perf + WAL archival
│   ├── conf.d/pg_hba.conf             # who can connect
│   ├── backup.sh                      # nightly basebackup → GCS
│   ├── restore.sh                     # scripted restore
│   ├── archive-wal.sh                 # archive_command target
│   └── cloud-init.yaml                # brings up the VM from scratch
├── redis/
│   ├── docker-compose.yml
│   ├── redis.conf                     # AOF + RDB
│   ├── backup.sh
│   └── cloud-init.yaml
└── Makefile                           # deploy / backup-now / restore helpers
```

## What lives where

| Concern | Postgres VM | Redis VM |
|---|---|---|
| Machine | `n2d-standard-2` (2 vCPU, 8 GB) | `e2-small` (1 vCPU, 2 GB) |
| Data disk | 200 GB SSD, `/var/lib/postgresql/data` | 20 GB standard, `/data` |
| Network | private subnet, no external IP | private subnet, no external IP |
| Ports (internal only) | `5432/tcp` | `6379/tcp` |
| Backups | nightly basebackup + continuous WAL → `gs://<PROJECT>-cred-pg-backups` | nightly RDB → `gs://<PROJECT>-cred-redis-backups` |
| Monitoring | postgres_exporter → OTel Collector on the same host | redis_exporter → same |
| OS updates | `unattended-upgrades` for security only | same |

## First-time bring-up

The setup below assumes the platform team has provisioned:

- A VPC + private subnet (e.g., `cred-vpc / cred-private`)
- Two service accounts (`cred-postgres-vm@…`, `cred-redis-vm@…`) with
  `roles/storage.objectAdmin` on the backup bucket only
- A GCS bucket per service for backups
- A Cloud DNS private zone entry:
  - `postgres.cred.internal → 10.x.x.x`
  - `redis.cred.internal    → 10.x.x.y`
- Firewall rules opening `5432` and `6379` **only** from the Serverless VPC
  Access connector's subnet

Then:

```bash
# 1. Create the Postgres VM with cloud-init.
gcloud compute instances create cred-postgres-1 \
  --machine-type=n2d-standard-2 \
  --subnet=cred-private --no-address \
  --service-account=cred-postgres-vm@$PROJECT.iam.gserviceaccount.com \
  --scopes=cloud-platform \
  --image-family=cos-stable --image-project=cos-cloud \
  --create-disk=name=cred-postgres-data,size=200GB,type=pd-ssd,mode=rw \
  --metadata-from-file=user-data=postgres/cloud-init.yaml \
  --tags=cred-postgres

# 2. Create the Redis VM the same way.
gcloud compute instances create cred-redis-1 \
  --machine-type=e2-small \
  --subnet=cred-private --no-address \
  --service-account=cred-redis-vm@$PROJECT.iam.gserviceaccount.com \
  --scopes=cloud-platform \
  --image-family=cos-stable --image-project=cos-cloud \
  --create-disk=name=cred-redis-data,size=20GB,type=pd-standard,mode=rw \
  --metadata-from-file=user-data=redis/cloud-init.yaml \
  --tags=cred-redis
```

## Application config

`packages/config/src/index.ts` already parses the two URLs. Set them in
Cloud Run env:

```
DATABASE_URL=postgres://cred:<password>@postgres.cred.internal:5432/cred
REDIS_URL=redis://:<password>@redis.cred.internal:6379/0
```

Passwords come from Secret Manager, mounted as env vars.

## Cost floor

| Line | Est monthly |
|---|---|
| `n2d-standard-2` (Postgres) | ~$50 |
| 200 GB SSD | ~$34 |
| `e2-small` (Redis) | ~$14 |
| 20 GB PD | ~$1 |
| GCS backups (≤ 50 GB) | ~$1 |
| **Total** | **~$100 / month** |
