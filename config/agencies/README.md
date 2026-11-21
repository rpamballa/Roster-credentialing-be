# Signal agency onboarding configs

One JSON file per agency declares everything Signal needs to light up
ingestion for that workspace: identity, specialists, config KV,
knowledge seeds, per-adapter credentials and configuration, and the
onboarding gaps to pre-open. The declarative file replaces the
ad-hoc, step-by-step runbook that prior Signal onboardings used.

## SOP (collapsed)

1. **Copy** `example.agency.json` to `<agency-slug>.agency.json`.
2. **Edit** the file — the schema is enforced by
   [`parseAgencyConfig`](../../packages/signal-ingest/src/onboarding/config.ts).
3. **Dry-run** to confirm the plan and resolve credentials:
   ```bash
   docker compose exec api tsx scripts/signal-onboard.ts \
     config/agencies/<agency-slug>.agency.json --dry-run
   ```
4. **Apply**:
   ```bash
   docker compose exec api tsx scripts/signal-onboard.ts \
     config/agencies/<agency-slug>.agency.json
   ```
5. **Verify** via `GET /v1/signal/adapters` (health chips) and
   `GET /v1/signal/gaps` (what's still blocking). Both surface in the
   onboarding UI.

The runner is idempotent — re-applying the same file converges. To
change an already-live agency: edit the file, re-run. History on the
`signal_workspace_config` table preserves every value so rollbacks are
a config.get at a prior timestamp.

## Credentials — never commit secrets

The schema accepts three credential sources, picked per adapter:

| Source   | Use                                          | Secrets touch disk? |
|----------|----------------------------------------------|---------------------|
| `env`    | Production (recommended)                     | Only via env var    |
| `file`   | Host-managed secret file (e.g. SOPS-decrypted) | Yes, out-of-repo    |
| `inline` | Dev + tests only                             | Yes, in the config  |

`inline` is refused when `NODE_ENV=production` unless
`--allow-inline-in-prod` is passed. Prefer `env` on the deployed VM
and never commit a config file whose `credentials.source` is `inline`
with real values.

## Phases

The runner executes these in order; each is independently rerunnable
via `--phase <name>`:

1. **workspace** — upsert `workspaces` row by `slug`; set `signal_enabled`.
2. **specialists** — upsert `users` by email; add `memberships` rows.
3. **config** — append `signal_workspace_config` rows (history
   preserved; byte-equal values are skipped).
4. **knowledge** — insert `signal_knowledge_documents` rows missing by
   title.
5. **credentials** — resolve → encrypt → upsert
   `signal_adapter_credentials`; adapter-level non-secret config lands
   as a `signal_workspace_config` row under scope `adapter.<name>`.
6. **adapters** — optional `preview` / `sync` kickoff per
   `runOnBootstrap` flags.
7. **gaps** — insert `signal_onboarding_gaps` rows missing by title.

## Schema reference

The source of truth is
[`packages/signal-ingest/src/onboarding/config.ts`](../../packages/signal-ingest/src/onboarding/config.ts).
TL;DR:

```jsonc
{
  "schemaVersion": 1,                 // bump when a breaking schema change lands
  "agency": { "slug": "...", "name": "...", "type": "agency", "signalEnabled": true },
  "specialists": [{ "email": "...", "name": "...", "role": "owner|admin|specialist|viewer" }],
  "config":      [{ "scope": "...", "key": "...", "value": <any JSON> }],
  "knowledge":   [{ "title": "...", "bodyMarkdown": "...", "tags": ["..."] }],
  "adapters": {
    "<adapter-name>": {
      "enabled": true,
      "cadenceMsOverride": 600000,
      "credentials": { "source": "env", "map": { "clientId": "SIGNAL_BULLHORN_CLIENT_ID" } },
      "config": { "restUrl": "..." },
      "runOnBootstrap": { "preview": true, "sync": false }
    }
  },
  "gaps": [{ "title": "...", "bodyMarkdown": "...", "status": "open" }]
}
```

Known adapter names come from
[`defaultAdapterRegistry`](../../packages/signal-ingest/src/adapters/registry.ts):
`roster-internal`, `bullhorn`, `avionte`, `laboredge`, `salesforce-crm`,
`gmail`, `outlook`, `ringcentral`, `twilio`. The runner refuses
unknown names up front.
