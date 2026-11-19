# Salesforce CRM adapter (stub)

**Docs:** https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/

## Auth flow

Standard OAuth 2 refresh-token flow against the agency's instance.

## Required scopes

- `api`
- `refresh_token`
- `offline_access`

## Rate limits

- API-call allocation varies by edition. Enterprise typically ships
  with 100k req/24h — safe for our cadence. Composite+batch is
  strongly preferred.

## Cursor shape

`{ lastModifiedDate: ISO string }` — every standard object exposes
`LastModifiedDate` and supports `WHERE LastModifiedDate > :cursor`.

## Known quirks

- Most agencies model "candidate" either as `Contact` or as a custom
  object (`Provider__c`). Read the mapping from
  `signal_workspace_config` rather than hard-coding.
- Field-level security may silently null out fields the running user
  can't read; the adapter's health check should SELECT a canary record
  and warn when a configured field comes back null.
