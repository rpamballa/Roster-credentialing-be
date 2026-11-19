# RingCentral adapter (stub)

**Docs:** https://developers.ringcentral.com/api-reference

## Auth flow

JWT bearer (preferred for server-to-server) — the agency generates a
long-lived JWT and we trade it for a short-lived access token per
session. `clientId` / `clientSecret` are the app credentials under
which the JWT was issued.

## Required scopes

- `ReadCallLog`
- `ReadMessages`

## Rate limits

- Heavy tier: 40 req/sec. Call-log listing is one of the most
  expensive endpoints — paginate aggressively.

## Cursor shape

`{ dateFrom: ISO string }` — the call-log endpoints take a `dateFrom`
query param. The adapter advances it by (last-batch's max start-time)
- 60s on each run.

## Known quirks

- Voicemail transcripts arrive late — the adapter must re-poll a
  call's `recording` URL for ~15 minutes after the initial fetch
  before concluding the transcript isn't coming.
- SMS threads can be very long; the adapter should batch by thread
  rather than per-message to keep conversation ordering stable.
