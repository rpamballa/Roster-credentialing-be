# Runbook — self-managed Postgres/Redis restore

Applies to the GCE deployment described in [ADR-0001](../decisions/0001-self-managed-postgres-redis.md).

## Postgres — point-in-time restore

### 1. Freeze writes

If the failure is data corruption rather than a total VM loss, stop the API
+ workers so no new writes land:

```bash
gcloud run services update cred-api    --region=$REGION --no-traffic
gcloud run services update cred-worker --region=$REGION --min-instances=0
```

### 2. Pick a target basebackup + PITR timestamp

```bash
gsutil ls -l gs://$PROJECT-cred-pg-backups/basebackup/ | sort
```

Choose the newest basebackup **≤ your target PITR time**. WAL segments
between that basebackup and the target time are replayed on top.

### 3. Provision a scratch VM (or reuse the current one)

For a first drill / a corruption event you don't fully understand, restore
into a scratch VM:

```bash
gcloud compute instances create cred-postgres-restore \
    --machine-type=n2d-standard-2 --subnet=cred-private --no-address \
    --service-account=cred-postgres-vm@$PROJECT.iam.gserviceaccount.com \
    --scopes=cloud-platform \
    --image-family=cos-stable --image-project=cos-cloud \
    --create-disk=name=cred-postgres-restore-data,size=200GB,type=pd-ssd \
    --metadata-from-file=user-data=postgres/cloud-init.yaml
```

### 4. Run the restore script on the target VM

```bash
gcloud compute ssh cred-postgres-restore --zone=$ZONE
cd /home/cred/postgres

# Provide the basebackup URI and (optionally) a target PITR time.
sudo BACKUP_BUCKET=$PROJECT-cred-pg-backups ./restore.sh \
    gs://$PROJECT-cred-pg-backups/basebackup/20260828T030000Z.tar.gz \
    "2026-08-28 14:00:00 UTC"
```

### 5. Verify

```bash
docker logs cred-postgres --tail 100
docker exec -it cred-postgres psql -U cred -d cred -c "\
    SELECT COUNT(*) FROM cases; \
    SELECT MAX(timestamp) FROM audit_log;"
```

If the last audit row lines up with your target time, the restore
succeeded. Run `SELECT pg_wal_replay_resume();` if you paused at a
target — that promotes to an accepting-writes instance.

### 6. Cut traffic over

Update the private-DNS `postgres.cred.internal` A record to the restored
VM's IP (Cloud DNS), then bring API + workers back:

```bash
gcloud run services update cred-api    --region=$REGION --traffic=LATEST=100
gcloud run services update cred-worker --region=$REGION --min-instances=1
```

## Redis — restore from RDB

Redis loss is annoying but not catastrophic — every session and rate-limit
counter dies. Provider magic-links still land in email, so users can
re-authenticate.

### 1. Fetch the snapshot

```bash
gsutil cp gs://$PROJECT-cred-redis-backups/rdb/<STAMP>.rdb /tmp/dump.rdb
```

### 2. Replace the running dump

```bash
gcloud compute ssh $REDIS_VM --zone=$ZONE
sudo docker compose -f /home/cred/redis/docker-compose.yml down
sudo cp /tmp/dump.rdb /data/dump.rdb
sudo chown redis:redis /data/dump.rdb   # uid mapping per image
sudo docker compose -f /home/cred/redis/docker-compose.yml up -d
```

Redis loads the RDB at startup. Confirm with:

```bash
docker exec cred-redis redis-cli -a "$REDIS_PASSWORD" DBSIZE
```

## Monthly drill

The first business day of each month, run **step 3 → 5 of the Postgres
runbook against a scratch VM** using the previous night's basebackup + WAL.
Record wall-clock RTO in the operations Linear project. If the drill fails
or exceeds 30 min, file a P1.

## What NOT to do

- Never edit files in `/var/lib/postgresql/data` while Postgres is running.
  If you need to nuke and restore, stop the container first (`docker
  compose down postgres`).
- Never `FLUSHDB` on Redis. The command is renamed to `""` in
  `redis.conf` and any attempt is a signal something is wrong.
- Never take the primary Postgres VM out of the LB unless you have a
  verified restore instance or streaming replica ready. There is no
  automatic failover.
