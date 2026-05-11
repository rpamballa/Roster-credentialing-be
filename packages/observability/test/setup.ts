// Test-only env shims so @cred/config validates successfully when modules
// load. None of these are read during the redaction unit tests; they only
// satisfy the Zod env schema at import time.
process.env.DATABASE_URL ??= "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL ??= "redis://localhost:6379/1";
process.env.SESSION_SECRET ??= "test-session-secret-1234567890";
process.env.NODE_ENV ??= "test";
