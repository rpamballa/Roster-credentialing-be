-- Required extensions for the credentialing platform.
-- pgcrypto: encryption helpers + gen_random_uuid()
-- pgmq:     postgres-backed message queue (per SPEC §2)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pgmq CASCADE;
