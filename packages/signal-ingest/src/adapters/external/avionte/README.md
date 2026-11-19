# Avionté adapter (stub)

**Docs:** https://developer.avionte.com/

## Auth flow

OAuth 2 client-credentials against Avionté's auth host. The tenantId
identifies the Avionté customer; tokens live ~60 minutes.

## Required scopes

- `candidates.read`
- `jobs.read`
- `placements.read`

Write scopes (status push-back) are deliberately out-of-scope for v1.

## Rate limits

- 100 req/min per tenant (standard tier). The adapter should batch and
  respect the `X-RateLimit-Remaining` header.

## Cursor shape

`{ lastSyncedAt: ISO string, lastCandidateId?: int }` — Avionté's
pagination is page+limit, not cursor. The adapter walks pages until it
finds a record with `lastModifiedDate` older than the cursor, then
stops.

## Known quirks

- Phone numbers come back unnormalized (mixed formats across tenants);
  normalize to E.164 before writing.
- License state codes include Canadian provinces — filter to US-only
  at the adapter boundary if the workspace's `targetedStates` does not
  include CA provinces.
