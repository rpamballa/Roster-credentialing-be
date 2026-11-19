# Twilio adapter (stub)

**Docs:** https://www.twilio.com/docs/api

## Auth flow

Account SID + auth token (basic auth). No refresh. Twilio supports API
keys as a safer alternative, but auth-token flow is the ubiquitous
starting point and we can graduate workspaces to API keys later.

## Required scopes

Twilio does not use OAuth scopes — API-key permissions are configured
at key-creation time on the Twilio console. The adapter needs
read-only access to `Messages`.

## Rate limits

- 1 req/sec per account by default (lifted on request). The Messages
  list endpoint is paginated; walk pages at ~10 msg/batch.

## Cursor shape

`{ dateSentBefore?: ISO string, dateSentAfter: ISO string }` — Twilio
exposes `DateSent>=` and `DateSent<=` filters. The cursor advances on
`DateSent>=`.

## Known quirks

- Twilio returns phone numbers in E.164; no normalization needed.
- Media (MMS) is not fetched by this adapter — only text SMS bodies.
- Status callbacks can lag; a message may appear with `queued` status
  on first fetch and flip to `delivered` later. Re-upsert on cursor
  overlap so the latest status wins.
