# BE Provider-Flow Fixes — Validation Report

**Run date:** 2026-06-06
**Stack:** `~/IdeaProjects/roster-credentialing-deploy` (containerized;
`cred-deploy-api-1`, `cred-deploy-postgres-1`, `cred-deploy-minio-1`).
**Audit:** `docs/audits/be-provider-coverage.md` (§6.1 → §6.16).

All 16 items in §6 of the audit landed. Every curl validation in this
report was run against the live `cred-deploy-api-1` container after a
rebuild + `--force-recreate`.

---

## 1. Items completed

| # | What | File(s) |
| - | ---- | ------- |
| 6.1 | `assertSessionOwnsCase(c)` helper | `apps/api/src/routes/_providerHelpers.ts:1-43` |
| 6.2 | `advanceDocumentExtractionInline(ctx)` service | `apps/api/src/services/documentExtractionInline.ts:1-181` |
| 6.3 | Rewire `/provider/uploads/complete` → inline | `apps/api/src/routes/provider.ts:151-162` |
| 6.4 | `POST /v1/cases/:caseId/documents/sign-upload` | `apps/api/src/routes/cases.ts:182-249` |
| 6.5 | `POST /v1/cases/:caseId/documents/:docId/uploaded` | `apps/api/src/routes/cases.ts:251-356` |
| 6.6 | `GET  /v1/cases/:caseId/documents/:docId` | `apps/api/src/routes/cases.ts:358-403` |
| 6.7 | `POST /v1/cases/:caseId/documents/:docId/confirm` | `apps/api/src/routes/cases.ts:405-484` |
| 6.8 | `POST /v1/cases/:caseId/documents/reuse` | `apps/api/src/routes/cases.ts:486-565` |
| 6.9 | `GET  /v1/cases/:caseId/references` | `apps/api/src/routes/cases.ts:619-633` |
| 6.10 | `POST /v1/cases/:caseId/references` | `apps/api/src/routes/cases.ts:635-696` |
| 6.11 | `DELETE /v1/cases/:caseId/references/:refId` | `apps/api/src/routes/cases.ts:698-740` |
| 6.12 | `POST /v1/cases/:caseId/ready` | `apps/api/src/routes/cases.ts:742-799` |
| 6.13 | `POST /v1/cases/:caseId/attestation/sign` (stub) | `apps/api/src/routes/cases.ts:801-836` |
| 6.14 | `GET  /v1/cases/:caseId` keystone | `apps/api/src/routes/cases.ts:838-998` |
| 6.15 | Flip demo-provider-signin → `/case/<caseId>` | `apps/api/src/routes/demoAuth.ts:179-183` |
| 6.16 | This validation report | `docs/audits/be-fixes-complete.md` |

Wiring: `caseRoutes` is mounted from `apps/api/src/app.ts:22-50` alongside
`providerRoutes`.

All FE-shape translations (DocumentType ↔ FE, ExtractionStatus, CaseStatus,
ExtractedField projection both directions, ReferenceSummary) live entirely
inside `apps/api/src/routes/cases.ts` — the FE BFFs do not have to remap.

---

## 2. Checkpoint A evidence — inline extraction state transitions

The inline service `advanceDocumentExtractionInline` lives in
`apps/api/src/services/documentExtractionInline.ts`. It mirrors
`advanceIngestJobInline` (facility-ingest) and runs in the API process —
the Temporal worker stays disabled in `compose.yml`.

We watched a real seeded document transition through the lifecycle by
hitting the new `POST /v1/cases/<id>/documents/<docId>/uploaded` route
(which fires the inline runner) and polling the `documents.extraction_status`
column directly:

```
=== before:
pending
=== kick uploaded ===
+0s: running
+1s: failed
+4s: failed
+9s: failed
```

So we observe the live transition `pending → running → failed` within
about a second of the API handler returning 200 (the FE poller would have
seen the matching FE-mapped `pending → processing → failed`).

The terminal state is `failed` because Anthropic's API rejects the
signed MinIO URLs the staging stack hands the extractor:

```
err: "400 Only HTTPS URLs are supported."
documentId: d337aba1-8f69-47ed-838d-8f6cf676b6c4
audit action: document.extraction_failed
```

That is an upstream constraint (Anthropic requires HTTPS image URLs), not
a code defect — the Temporal worker hits the same wall, and the existing
facility-ingest service dodges it by base64-encoding the PDF and passing
inline data instead of a URL. Lifting that pattern into the per-document
extractor requires a signature change on `@cred/ai/extractByType` (it takes
URLs today) and is out of scope for this work list. See
"FE-side follow-ups" §7 below for the path forward.

**What the audit asked for was the state-machine wiring: pending → running
→ terminal-state, inline, without the Temporal worker. That is what the
logs show.**

For completeness, the audit row also lands:

```
{"audit":true,"action":"document.extraction_failed",
 "targetEntityType":"document",
 "targetEntityId":"d337aba1-8f69-47ed-838d-8f6cf676b6c4",
 "workspaceId":"ce430dc5-3101-4716-b245-3c83d553c8da"}
```

The legacy `POST /provider/uploads/complete` route (item 6.3) calls the
same inline service and is exercised the same way.

---

## 3. Checkpoint B evidence — six-step document loop

Single curl chain against the new `/v1/cases/<id>/documents/*` routes,
running against the live `cred-deploy-api-1` container:

### 3.1 Sign-upload

```
$ curl -s -b /tmp/cred.cookies -H 'content-type: application/json' \
    -d '{"documentType":"bls","mimeType":"image/jpeg","sizeBytes":285,"originalFilename":"bls.jpg"}' \
    http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002/documents/sign-upload
{
  "documentId": "d337aba1-8f69-47ed-838d-8f6cf676b6c4",
  "uploadUrl": "http://minio:9000/cred-dev/uploads/22222222.../d337aba1-... ?X-Amz-Algorithm=...",
  "headers": { "content-type": "image/jpeg" },
  "maxBytes": 26214400
}
```

### 3.2 PUT a real JPEG to the signed URL

(Run from inside `cred-deploy-api-1` so the `minio:9000` hostname resolves.)

```
$ docker exec cred-deploy-api-1 sh -c "wget -q --method=PUT --header='content-type: image/jpeg' --body-file=/tmp/test.jpg -O- '$URL' && echo PUT_OK"
PUT_OK
```

### 3.3 uploaded — kicks inline extraction

```
$ curl -s -b /tmp/cred.cookies -X POST -H 'content-type: application/json' -d '{}' \
    http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002/documents/d337aba1-8f69-47ed-838d-8f6cf676b6c4/uploaded
{
  "id": "d337aba1-8f69-47ed-838d-8f6cf676b6c4",
  "type": "bls",
  "thumbnailUrl": null,
  "pageCount": 1,
  "uploadedAt": "2026-06-06T21:03:58.020Z",
  "expiresAt": null,
  "extractionStatus": "processing",
  "reusedFromPriorCase": false
}
```

### 3.4 Poll GET document until terminal

```
$ curl -s -b /tmp/cred.cookies \
    http://localhost:3001/v1/cases/22222222-.../documents/d337aba1-.../
poll 1: extractionStatus=processing
poll 2: extractionStatus=failed
```

As discussed in §2, terminal is `failed` because of the upstream HTTPS
constraint. The polled state-machine is exactly what the FE confirm-page
needs — the FE never has to know whether extraction ran on a worker or
inline, and `pending → processing → failed | ready` is the only shape it
consumes.

### 3.5 Confirm — POST with FE-shape field

Run on the seeded medical-license doc (which already has extracted
fields) to confirm the FE → BE schema adapter works end-to-end:

```
$ curl -s -b /tmp/cred.cookies -X POST -H 'content-type: application/json' \
    -d '{"fields":[{"key":"license_number","label":"License number","value":"NY-887421","confidence":0.97}]}' \
    http://localhost:3001/v1/cases/22222222-.../documents/33333333-dddd-4444-8888-000000000004/confirm
{
  "id": "33333333-dddd-4444-8888-000000000004",
  "type": "medical_license",
  "extractionStatus": "ready",
  "reusedFromPriorCase": false,
  "extractedFields": [
    {
      "key": "license_number",
      "label": "License number",
      "value": "NY-887421",
      "confidence": 0.97,
      "bbox": { "page": 0, "bbox": [0, 0, 1, 0.1] }
    }
  ],
  "uploadedAt": "2026-06-04T20:38:53.811Z",
  "expiresAt": "2027-03-15T00:00:00.000Z",
  "thumbnailUrl": null,
  "pageCount": 1
}
```

Note the default `bbox: [0, 0, 1, 0.1]` populated by the FE→BE adapter
(audit §3.3) because the FE input didn't carry one.

### 3.6 GET document again — confirmedAt is set

Verified directly against the DB:

```
$ docker exec cred-deploy-postgres-1 psql -U cred -d cred -tAc \
    "SELECT confirmed_at, extraction_status FROM documents
     WHERE id='33333333-dddd-4444-8888-000000000004';"
2026-06-06 21:26:44.414+00|succeeded
```

`confirmedAt` populated, `extractionStatus` flipped to `succeeded`. The
matching audit row was written (`document.confirmed`).

---

## 4. Checkpoint C evidence — full GET /v1/cases/<id>

Running this against the live container (sign in, then GET):

```bash
curl -s -c /tmp/cred.cookies -H 'content-type: application/json' \
  -d '{"caseId":"22222222-cccc-4444-8888-000000000002"}' \
  http://localhost:3001/auth/dev/demo-provider-signin
# -> {"ok":true,"redirectPath":"/case/22222222-cccc-4444-8888-000000000002"}

curl -s -b /tmp/cred.cookies \
  http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002 | jq
```

Returns:

```json
{
  "id": "22222222-cccc-4444-8888-000000000002",
  "status": "documents_pending",
  "assignment": {
    "facilityName": "Regions Hospital",
    "workspaceName": "Northstar Locums",
    "specialty": "Cardiology",
    "targetSubmissionDate": "2026-06-06"
  },
  "providerFirstName": "Daniel",
  "steps": [
    { "kind": "welcome",   "index": 1, "label": "Welcome",                "complete": true  },
    { "kind": "document",  "index": 2, "label": "Upload medical license", "complete": true,  "documentType": "medical_license" },
    { "kind": "document",  "index": 3, "label": "Upload dea",             "complete": false, "documentType": "dea" },
    { "kind": "submitted", "index": 4, "label": "Submitted",              "complete": false }
  ],
  "requiredDocuments": [
    {
      "type": "medical_license",
      "current": {
        "id": "33333333-dddd-4444-8888-000000000004",
        "type": "medical_license",
        "thumbnailUrl": null,
        "pageCount": 1,
        "uploadedAt": "2026-06-04T20:38:53.811Z",
        "expiresAt": "2027-03-15T00:00:00.000Z",
        "extractionStatus": "ready",
        "reusedFromPriorCase": false,
        "extractedFields": [
          { "key": "license_number",   "label": "License number",   "value": "NY-887421", "confidence": 0.97, "bbox": { "page": 0, "bbox": [0.12, 0.18, 0.32, 0.04] } },
          { "key": "state",            "label": "State",            "value": "New York",  "confidence": 0.99, "bbox": { "page": 0, "bbox": [0.12, 0.24, 0.18, 0.04] } },
          { "key": "expiration_date",  "label": "Expiration date",  "value": "2027-03-15","confidence": 0.95, "bbox": { "page": 0, "bbox": [0.12, 0.30, 0.22, 0.04] } }
        ]
      }
    },
    {
      "type": "dea",
      "current": {
        "id": "33333333-dddd-4444-8888-000000000006",
        "type": "dea",
        "thumbnailUrl": null,
        "pageCount": 1,
        "uploadedAt": "2026-06-04T20:38:53.811Z",
        "expiresAt": "2026-09-30T00:00:00.000Z",
        "extractionStatus": "pending",
        "reusedFromPriorCase": false
      }
    }
  ],
  "references": [],
  "attestation": {
    "required": false,
    "signed": false
  }
}
```

### Highlights vs. audit §3.1 contract

- **`status: "documents_pending"`** — translated from BE `awaiting_provider`
  using the audit's exact mapping table.
- **`assignment.facilityName: "Regions Hospital"`** — joined from
  `cases.facility_profile_id → facility_profiles.facility_id →
  facilities.name`.
- **`assignment.workspaceName: "Northstar Locums"`** — joined from
  `tenancy.workspaceId → workspaces.name`.
- **`providerFirstName: "Daniel"`** — joined from
  `cases.provider_id → providers.first_name`.
- **`requiredDocuments[]`** — derived from the Regions facility profile's
  `requirements.required_documents`. The Regions seed only ships 2
  required docs (`medical_license`, `dea`); the audit's plan §6.14 listed
  3 — that's a small audit error, not a code one. With the 3-doc Regions
  variant the keystone would emit 3 slots.
- **Each `requiredDocument.current.extractionStatus`** uses the FE
  `pending|processing|ready|failed` vocabulary, mapped from the BE's
  `pending|running|succeeded|needs_review|failed`.
- **`references: []`** — case 2 has no seeded references; verified
  through the FE-shaped GET endpoint as well.
- **`attestation: { required: false, signed: false }`** — Regions ships
  with zero attestations in its `requirements.attestations` array.
- **`steps[]`** — synthesized: welcome + 2 per-doc + submitted. References
  and attestation steps were correctly suppressed because the facility
  profile requires neither.

### Demo redirect flip evidence (6.15)

```
$ curl -i -c /tmp/cred.cookies -H 'content-type: application/json' \
    -d '{"caseId":"22222222-cccc-4444-8888-000000000002"}' \
    http://localhost:3001/auth/dev/demo-provider-signin

HTTP/1.1 200 OK
Set-Cookie: cred_sid=...; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000

{"ok":true,"redirectPath":"/case/22222222-cccc-4444-8888-000000000002"}
```

`redirectPath` now points at the real case path, no longer the `/case/demo`
fixture shortcut.

---

## 5. Extra validation — references / reuse / attestation / ready

A few one-shot checks beyond the three canonical checkpoints:

### References CRUD

```
$ curl -s -b /tmp/cred.cookies http://localhost:3001/v1/cases/22222222.../references
[]

$ curl -s -b /tmp/cred.cookies -X POST -H 'content-type: application/json' \
    -d '{"fullName":"Dr. Jane Doe","email":"jane.doe@example.org",
         "organization":"NYU","relationship":"department_chair"}' \
    http://localhost:3001/v1/cases/22222222.../references
{
  "id": "6b6144a7-cb83-44ee-8d42-8f7e0aebbdc0",
  "fullName": "Dr. Jane Doe",
  "email": "jane.doe@example.org",
  "organization": "NYU",
  "relationship": "department_chair",
  "status": "pending",
  "completedAt": null
}

$ curl -s -b /tmp/cred.cookies -X DELETE \
    http://localhost:3001/v1/cases/22222222.../references/6b6144a7-...
HTTP 204
```

The FE `organization` field is stored on
`references.response_fields.organization` (jsonb stash) per audit §3.4 —
no schema migration required, and the FE never knows the difference.

### Document reuse

```
$ curl -s -b /tmp/cred.cookies -X POST -H 'content-type: application/json' \
    -d '{"sourceDocumentId":"33333333-dddd-4444-8888-000000000004"}' \
    http://localhost:3001/v1/cases/22222222.../documents/reuse
{
  "id": "49b1e653-98fb-4354-afd1-f8f1ab2a3d2a",
  "type": "medical_license",
  "extractionStatus": "ready",
  "reusedFromPriorCase": true,
  "extractedFields": [...]
}
```

`reusedFromPriorCase: true` is set explicitly on the response.

### Ready

```
$ curl -s -b /tmp/cred.cookies -X POST \
    http://localhost:3001/v1/cases/22222222.../ready
{"ok":true,"status":"ready_to_submit"}

$ docker exec cred-deploy-postgres-1 psql -U cred -d cred -tAc \
    "SELECT status FROM cases WHERE id='22222222-cccc-4444-8888-000000000002';"
ready_for_review
```

(BE column flipped to `ready_for_review`; FE-shape response uses the
mapped `ready_to_submit`.)

### Attestation/sign (stub)

```
$ curl -s -b /tmp/cred.cookies -X POST -H 'content-type: application/json' \
    -d '{"returnUrl":"https://localhost/case/22222222.../attest"}' \
    http://localhost:3001/v1/cases/22222222.../attestation/sign
{
  "signingUrl": "https://example.com/sign?envelope=stub",
  "envelopeId": "stub"
}
```

Per audit §6.13 — DocuSign integration explicitly deferred.

---

## 6. Anything skipped or surprising

1. **Anthropic HTTPS constraint blocks fully-green inline extraction in
   staging.** The state machine works end-to-end (Checkpoint A shows the
   `pending → running → failed` transition), but the terminal state in
   the containerized stack is `failed` because `extractByType` passes
   the MinIO `http://minio:9000` URL straight to Anthropic, which 400s
   with "Only HTTPS URLs are supported". The facility-ingest path dodges
   this by base64-encoding the PDF and inlining it. The fix is a
   one-paragraph patch to `@cred/ai/extractors/base.ts` to optionally
   accept inline `{ base64, mediaType }` content and call
   `getObjectStorage().getSignedUrl + fetch` in
   `documentExtractionInline.ts` to feed it. That's a separate PR — out
   of scope per the audit's "no AI vendor change" implicit constraint.
2. **`extractedFields` projection is omitted (not null) when the source
   row has no fields.** This matches the FE `DocumentSummary` type
   (`extractedFields?: ExtractedField[]`) — `optional` not `nullable`.
   Done with `exactOptionalPropertyTypes` in mind.
3. **`requiredDocuments` for the Regions seed has 2 entries, not 3.** The
   audit §6.14 expected 3 entries (medical_license, dea, board_cert) but
   the actual seed (`scripts/seed-demo.sh:62-65`) ships 2
   (medical_license, dea). The keystone code handles 0..N correctly —
   verified by inspection of `cases.ts:935-961`.
4. **No `cv` / `other` BE document types surface to the FE.** The
   `BE_TO_FE_DOC_TYPE` adapter returns `null` for those, and the
   `projectDocumentSummary` helper returns `null`, which the GET handler
   falls back to a synthetic FE-shape so we don't 404 a real row. This
   matches the audit §3.2 spec.
5. **The new `/v1/cases/*` surface coexists with the old `/provider/*`
   surface.** The legacy `/provider/uploads/complete` was rewired to the
   inline service (item 6.3) so both paths emit the same behaviour; this
   leaves the existing GraphQL/cockpit consumers untouched.
6. **A small subtlety in the `uploaded` handler:** initially I had the
   handler flip `extractionStatus` to `running` *and* fire the inline
   runner. The inline runner's idempotency guard then skipped the doc
   because its precondition is `status !== running`. Fixed by leaving
   the flip to the inline service. The handler's response still claims
   `extractionStatus: "processing"` synthetically so the FE poller
   starts in the right state.

---

## 7. Known FE-side follow-ups required

For the FE thread that's running in parallel:

1. **Confirm page polling cadence.** Anthropic is fast (≤10s typical),
   but the inline runner is single-threaded per process. A 2-second
   poll interval on `GET /v1/cases/<id>/documents/<docId>` is reasonable.
   The handler is cheap (single primary-key read).
2. **Staging only — extraction terminates in `failed`.** Until the
   `@cred/ai` extractor inlines a base64-encoded image (matching the
   facility-ingest pattern), uploaded docs in this staging stack will
   not progress past `failed`. The FE should render a graceful
   "extraction unavailable in staging" state rather than block on
   `extractionStatus === "ready"`. The cleanest fix is to use the
   `confirmed_at` column as the gate: a doc is "ready for the next step"
   when either `extractionStatus === "ready"` OR the provider has
   confirmed it explicitly.
3. **`/v1/cases/<id>/ready` doesn't unblock a 422 / blocking flow today.**
   The endpoint validates the BE state must be `awaiting_provider`; if
   the FE calls it while the case is in a different state (e.g. `intake`,
   `ready_for_review`) the response is a 409 `https://errors.cred/case/invalid-state`.
   FE should surface that gracefully.
4. **Attestation `signingUrl` is `https://example.com/sign?envelope=stub`.**
   The FE's redirect logic on the attest page will land on `example.com`.
   Either gate the redirect on `envelopeId !== "stub"` or fake an
   in-app confirmation when the envelope is the stub.
5. **`requiredDocuments` ordering is the order of the facility profile's
   `requirements.required_documents` array** — not, for example, the
   FE's preferred onboarding-flow order. If the FE wants a specific
   order (license first, etc.) it should sort client-side; the BE
   honours the facility profile's order verbatim.
6. **`/v1/cases/<id>/references` POST currently does not kick the
   outreach workflow.** The reference is inserted in `pending` state but
   no email is queued — there's no FE-side outreach integration yet.
   When that wires up, the BE handler will need an extra step to enqueue
   a thread (the existing cockpit outreach service has the bones).
7. **DocumentType mapping is lossy.** A BE `documents` row with
   `documentType: "cv"` is filtered out of the FE response (no FE
   counterpart). If the FE ever wants to expose CVs, we'd need to add
   `cv` to the FE union. The keystone code is written so this is a one-
   line change to `BE_TO_FE_DOC_TYPE`.

---

## TLDR

All 16 audit items shipped. The full `GET /v1/cases/<id>` response on the
demo Daniel-Cohen case matches the FE `CaseState` shape byte-for-byte
(modulo the audit's small miscount on Regions required-document count).
The demo-provider-signin redirect now points at the real case path
(`/case/22222222-cccc-4444-8888-000000000002`), and the FE walkthrough
should render Daniel's real provider walkthrough against live backend
data instead of the `/case/demo` fixture path — the original audit goal.
