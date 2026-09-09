# seed-data

Two fixtures that give a fresh local stack something to look at.

## `regional-medical-em-packet.json`

A Resend-shaped inbound-email payload representing Regional Medical
Center's Emergency Medicine credentialing packet. The recipient
(`requirements+acme@platform.example.com`) matches the workspace
provisioned by `pnpm db:seed`, so posting this payload to
`POST /webhooks/email/inbound` exercises the facility-ingestion path
end-to-end.

The parser needs an `ANTHROPIC_API_KEY`; without one the ingest workflow
will fail to promote the inbound email to a facility-profile draft. That's
expected — the payload is here to demo the intake surface, not the LLM
call.

### Post the fixture to a local API

```bash
curl -sS -X POST http://localhost:3001/webhooks/email/inbound \
  -H 'content-type: application/json' \
  --data @infrastructure/docker/seed-data/regional-medical-em-packet.json
```

Expect a `200` with `{ "ok": true, "inboundEmailId": "..." }`. You should
then see a new row in `inbound_emails` for that workspace and a Temporal
`facilityIngestWorkflow` scheduled.

## Companion: `pnpm db:seed`

Run first from the repo root:

```bash
pnpm db:seed
```

Idempotent. Creates the `acme` agency workspace (with the inbound address
above), an owner + specialist, an approved Regional Medical Center
facility profile, three providers with mixed document sets, and three
cases in different statuses. Output is JSON on stdout — capture
`workspaceId` and the case ids for follow-up API calls.
