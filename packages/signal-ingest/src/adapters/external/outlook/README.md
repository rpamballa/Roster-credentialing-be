# Outlook adapter (stub)

**Docs:** https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview

## Auth flow

Microsoft Graph OAuth 2 — client credentials with `application`
permissions for a service principal, or auth-code for a per-user
consent. Pick the model that matches the agency's IT policy during
onboarding.

## Required scopes

- `Mail.Read`
- `offline_access`

Application-scoped `Mail.Read` grants mailbox-wide read access (useful
for a shared recruiter inbox); for per-user flows use the delegated
variant.

## Rate limits

- 10,000 req/10 min/application. Graph returns 429 with
  `Retry-After`; the adapter must honour it.

## Cursor shape

`{ deltaToken: string }` — Graph's `/messages/delta` endpoint hands
you a token to resume from. Falls back to
`$filter=receivedDateTime ge :cursor` when cold.

## Known quirks

- Graph throttles per-mailbox independently of per-application; a
  heavy backfill against one mailbox can 429 even when the app's
  budget is fresh.
- `bodyPreview` is capped at 255 chars — pull `body.content` for the
  full normalized text.
