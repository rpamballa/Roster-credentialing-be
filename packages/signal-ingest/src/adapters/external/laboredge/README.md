# LaborEdge adapter (stub)

**Docs:** https://api.laboredge.com/docs

## Auth flow

Static API key per account, scoped to a single accountId. No refresh.

## Required scopes

- `read:jobs`
- `read:candidates`
- `read:credentials`

## Rate limits

- 60 req/min per account. The adapter should throttle internally — the
  circuit breaker's threshold will trip quickly otherwise.

## Cursor shape

`{ since: ISO string }` — LaborEdge supports `?modifiedSince=` on
every list endpoint.

## Known quirks

- Conversations are NOT exposed by LaborEdge; capability list omits
  `"conversations"`. Pair this adapter with gmail/outlook for touch
  history.
- Pay rates are posted as a `{ min, max, type }` block; the adapter
  must decide which to persist (recommendation: `max` for pay-at-
  ceiling signals).
