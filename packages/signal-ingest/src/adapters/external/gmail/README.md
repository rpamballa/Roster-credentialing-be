# Gmail adapter (stub)

**Docs:** https://developers.google.com/gmail/api/guides

## Auth flow

OAuth 2 with offline access. For an agency mailbox, prefer a Google
Workspace service account with domain-wide delegation so individual
recruiters don't have to re-consent when they rotate. The `userEmail`
credential is the mailbox the service account impersonates.

## Required scopes

- `https://www.googleapis.com/auth/gmail.readonly`

Write scopes (send-on-behalf) are an explicit v2 feature; the v1
adapter is read-only to keep the consent prompt narrow.

## Rate limits

- 250 quota units/user/sec, 1 billion units/day per project. The list
  + get operations we need are 5 units each — comfortable headroom.

## Cursor shape

`{ historyId: string }` — Gmail's `users.history.list` is the
cursor-friendly way to pick up new messages; fall back to `q=` +
`after:` when the cursor is cold.

## Known quirks

- Threaded conversations: the adapter must dedupe on `Message-ID`, not
  Gmail's internal `id` (the same message can appear under multiple
  Gmail ids across INBOX/SENT).
- MIME parsing: use the `raw` format and parse with mailparser — HTML
  bodies are rewritten by Google's proxy with tracking pixels.
