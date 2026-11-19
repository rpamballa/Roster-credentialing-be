# Bullhorn adapter (stub)

**Docs:** https://bullhorn.github.io/rest-api-docs/

## Auth flow (OAuth 2 — authorization code + refresh)

1. The agency's Bullhorn admin creates an API user at the vendor's
   cluster-specific auth host (e.g. `auth.bullhornstaffing.com`).
2. Roster stores `{clientId, clientSecret, refreshToken, restUrl}` in
   `signal_adapter_credentials` (encrypted). Access tokens are
   derived from the refresh token at runtime.
3. The adapter trades the access token for a REST session via
   `/login?version=*&access_token=*`, then uses the returned
   `BhRestToken` + `restUrl` for every subsequent call.

## Required scopes

- `READ` — the adapter is pull-only in v1. A later write path (pushing
  back notes / status) will need `WRITE` too.

## Rate limits

- 10 req/sec per corp, bursty up to 30. Treat the adapter as "work in
  batches of 100, sleep 100ms between batches" and the breaker's
  default threshold won't trip.

## Cursor shape

`{ lastModifiedAt: ISO string }` — Bullhorn's REST entities all carry
`dateLastModified` and support `dateLastModified>=` filters.

## Known quirks

- Clusters have per-tenant REST URLs; the login handshake returns the
  right one — never hardcode.
- `dateLastModified` is wall-clock, not UTC — stamp the cursor with a
  60s safety overlap on each sync.
- Candidate NPI lives on a custom field most agencies name
  `customText1`. Read the field mapping from `signal_workspace_config`.
