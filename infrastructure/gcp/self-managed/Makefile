# Convenience targets for the self-managed stack.
# Assumes PROJECT + REGION + ZONE are exported.

PROJECT ?= $(shell gcloud config get-value project 2>/dev/null)
REGION  ?= us-central1
ZONE    ?= us-central1-a

PG_VM    = cred-postgres-1
REDIS_VM = cred-redis-1

.PHONY: help sync-postgres sync-redis create-postgres create-redis \
        backup-postgres backup-redis pg-shell redis-shell status

help:
	@echo "targets:"
	@echo "  make sync-postgres      - rsync postgres/ onto \$$PG_VM"
	@echo "  make sync-redis         - rsync redis/    onto \$$REDIS_VM"
	@echo "  make create-postgres    - gcloud compute instances create (see README)"
	@echo "  make create-redis       - gcloud compute instances create"
	@echo "  make backup-postgres    - trigger an ad-hoc basebackup on the VM"
	@echo "  make backup-redis       - trigger an ad-hoc RDB snapshot on the VM"
	@echo "  make pg-shell           - open a psql on the postgres VM"
	@echo "  make redis-shell        - open a redis-cli on the redis VM"
	@echo "  make status             - describe both VMs + last backup timestamps"

sync-postgres:
	gcloud compute scp --recurse postgres/ $(PG_VM):/home/cred/ --zone=$(ZONE)

sync-redis:
	gcloud compute scp --recurse redis/ $(REDIS_VM):/home/cred/ --zone=$(ZONE)

backup-postgres:
	gcloud compute ssh $(PG_VM) --zone=$(ZONE) --command \
	    "cd /home/cred/postgres && sudo /home/cred/postgres/backup.sh"

backup-redis:
	gcloud compute ssh $(REDIS_VM) --zone=$(ZONE) --command \
	    "cd /home/cred/redis && sudo /home/cred/redis/backup.sh"

pg-shell:
	gcloud compute ssh $(PG_VM) --zone=$(ZONE) --command \
	    "docker exec -it cred-postgres psql -U cred -d cred"

redis-shell:
	gcloud compute ssh $(REDIS_VM) --zone=$(ZONE) --command \
	    "docker exec -it cred-redis redis-cli"

status:
	@echo "── postgres VM ──"
	@gcloud compute instances describe $(PG_VM) --zone=$(ZONE) \
	    --format="value(status,machineType.basename())" || true
	@echo "last postgres basebackup:"
	@gsutil ls -l "gs://$(PROJECT)-cred-pg-backups/basebackup/" | tail -3 || true
	@echo "── redis VM ──"
	@gcloud compute instances describe $(REDIS_VM) --zone=$(ZONE) \
	    --format="value(status,machineType.basename())" || true
	@echo "last redis snapshot:"
	@gsutil ls -l "gs://$(PROJECT)-cred-redis-backups/rdb/" | tail -3 || true
