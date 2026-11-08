# Signal · Adapters

This directory owns the **adapter contract** every external data source
will implement when Signal expands past the seed agency (Roster
Healthcare).

For v0 the only adapter wired up is **`roster-internal`**, implemented
by `../readers/*.ts` — it reads Roster's own Postgres tables and treats
them as the "external system". When the first external agency onboards
(v1), additional adapters land here against the interface in
`types.ts`.

## Shipped in v0

| Adapter          | Status  | Source                              | Notes                                              |
| ---------------- | ------- | ----------------------------------- | -------------------------------------------------- |
| `roster-internal`| wired   | Roster Postgres (`providers`, `cases`, `verifications`, `outreach_messages`) | Implemented in `../readers/`. |

## Deferred to v1 (interface designed, not bound)

Each row below is an adapter that WILL satisfy
`SignalIngestAdapter` from `./types.ts`, but is not implemented yet.
The runner already iterates a registered-adapter list; adding one is a
new file + a registration — no runner changes needed.

| Adapter            | Vendor(s)                                       | Replaces reader(s)       | Why deferred                                                                                                                              |
| ------------------ | ----------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ats-bullhorn`     | Bullhorn REST                                   | providers, jobs          | External agencies' systems of record. Needs OAuth setup + partner sandbox. First external pilot will pick ONE of these to bind.           |
| `ats-sense`        | Sense                                           | providers, jobs          | Same as above — defer to first external pilot.                                                                                            |
| `ats-crelate`      | Crelate                                         | providers, jobs          | Same as above.                                                                                                                            |
| `ats-jobdiva`      | JobDiva                                         | providers, jobs          | Same as above.                                                                                                                            |
| `crm-salesforce`   | Salesforce                                      | conversations (outbound) | Agencies that track recruiter touches in SFDC; needs a connected app + per-tenant SOQL mapping.                                           |
| `sms-twilio`       | Twilio Programmable Messaging + Status Callback | conversations            | Inbound SMS consent handling (`STOP`/`HELP`) adds compliance surface — deferred until a pilot agency actually runs SMS through us.        |
| `voice-twilio`     | Twilio Voice + Recording                        | conversations            | Transcription + consent recording is a separate workstream.                                                                               |
| `email-resend-in`  | Resend inbound webhook                          | conversations            | The `inboundEmails` table already exists in Roster schema; a reader against it is trivial and will land when v1 opens the inbound queue. |
| `verify-primary`   | NPDB, DEA, state board PSV adapters             | credentials              | Already partially owned by `verifications` for credentialing; the Signal side consumes them. No external integration change in v0.        |

## Shape of every adapter

See `types.ts`. In one paragraph:

- An adapter is an object with a stable `name` (used in
  `signal_source_lineage.external_system`) and five async read methods,
  one per canonical table — providers, jobs, facilities, credentials,
  conversations.
- Each method returns an array of canonical-ish records. Each record
  carries a `source: { externalSystem, externalId }` pointer the runner
  writes to `signal_source_lineage` after upserting the canonical row.
- Adapters do **not** write to the DB directly. The runner owns writes
  so entity resolution + lineage + the tenant-scoped DAL stay in one
  place.
- Returning an empty array means "I have nothing to contribute" — stubs
  are a first-class state (the v0 `conversations` reader does this when
  no outbound email history exists; see runner summary gaps).

## Adding a new adapter (v1 playbook)

1. Create `packages/signal-ingest/src/adapters/<name>.ts` whose default
   export satisfies `SignalIngestAdapter`.
2. Register it in `../runner.ts` alongside `rosterInternalAdapter`.
3. Each adapter is wrapped in its own circuit breaker in the runner, so
   an unhealthy vendor degrades to "skipped" rather than crashing the
   sync.
4. Add vitest coverage against `./types.ts` fixtures — no DB needed for
   the reader itself; the runner already has DB coverage.
