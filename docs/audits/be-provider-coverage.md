# BE Provider-Flow Coverage Audit

**Audit date:** 2026-06-06
**Subject:** `~/IdeaProjects/roster-credentialing-be`
**Reference repos:** `~/PycharmProjects/Roster-credentialing-fe` (FE contracts),
`~/IdeaProjects/roster-credentialing-deploy` (compose/env)

This audit walks the demo provider flow — Daniel Cohen / case
`22222222-cccc-4444-8888-000000000002` (Cardiology @ Regions Hospital,
`awaiting_provider`, workspace `northstar-locums`
`042e56f1-1ca0-4ef0-8efc-37d50b1a6202`) — end to end and reports on what
backend surface needs to exist for the FE to render the full provider UX
against real data instead of the `/case/demo` fixture path.

---

## 1. Existing `/provider/*` endpoint inventory

All provider-scoped routes today live in
`apps/api/src/routes/provider.ts`. The router is mounted at the app root in
`apps/api/src/app.ts:48` (`app.route("/", providerRoutes)`).

Auth middleware wiring (`apps/api/src/routes/provider.ts:58-60`):

```ts
providerRoutes.use("/provider/uploads/*",   requireProviderAuth, requireProviderTenancy);
providerRoutes.use("/provider/case/*",      requireProviderAuth, requireProviderTenancy);
providerRoutes.use("/provider/documents/*", requireProviderAuth, requireProviderTenancy);
```

The `requireProviderAuth` middleware lives in
`apps/api/src/middleware/session.ts:40-45`; `requireProviderTenancy` lives in
`apps/api/src/middleware/tenancy.ts:70-77` and binds `c.var.tenancy` to the
case's workspace (the `caseWorkspaceId` field on the provider session
payload).

### 1.1 `POST /provider/auth/redeem`

- **File:line:** `apps/api/src/routes/provider.ts:22-54`
- **Auth:** none — anonymous (this is how a magic-link invite mints a provider
  session in the first place).
- **Request body (zod):**
  ```ts
  z.object({ token: z.string().min(32).max(256) })
  ```
- **Response:** `{ ok: true, caseId, providerId }` on success;
  `application/problem+json` 400 on `CaseAccessInvalidError`.
- **Side effects:** sets `cred_sid` cookie (httpOnly, SameSite=Lax, 30d),
  calls `redeemCaseAccessToken` (`@cred/auth`) which (per its name) is
  expected to be single-use.
- **Summary:** redeem a case-access token from a magic-link URL and bind a
  provider session to (`providerId`, `caseId`, `caseWorkspaceId`).

### 1.2 `POST /provider/uploads/initiate`

- **File:line:** `apps/api/src/routes/provider.ts:67-88`
- **Auth:** `requireProviderAuth` + `requireProviderTenancy`.
- **Request body (zod):**
  ```ts
  z.object({
    contentType: z.string().min(1).max(128),
    originalFilename: z.string().min(1).max(255).optional(),
  })
  ```
- **Response:**
  ```ts
  {
    uploadId: string;        // = the S3 key, "uploads/<caseId>/<uuid>"
    url: string;             // pre-signed PUT URL
    method: "PUT";
    headers: Record<string, string>;
    expiresAt: string;       // ISO
    originalFilename: string | null;
  }
  ```
- **Side effects:** none beyond calling `getObjectStorage().putSignedUrl`
  (15-min TTL). No DB row is created at this step.
- **Summary:** hand the client a pre-signed S3/MinIO PUT URL keyed by case.

### 1.3 `POST /provider/uploads/complete`

- **File:line:** `apps/api/src/routes/provider.ts:97-166`
- **Auth:** `requireProviderAuth` + `requireProviderTenancy`.
- **Request body (zod):**
  ```ts
  z.object({
    uploadId: z.string().min(1).max(512),
    originalFilename: z.string().max(255).optional(),
    mimeType: z.string().min(1).max(128),
    pageCount: z.number().int().positive().max(2000).optional(),
  })
  ```
- **Response:** `{ documentId: string, extractionStatus: "pending" }` (200);
  409 `https://errors.cred/upload/missing` when the object isn't in storage.
- **Side effects:**
  1. `getObjectStorage().exists(uploadId)` — bails with 409 if missing.
  2. Inserts a `documents` row with `documentType: "other"`,
     `source: "provider_upload"`, `extractionStatus: "pending"`,
     `providerId: session.providerId`,
     `fileUri: uploadId` (the S3 key).
  3. Writes `audit.document.uploaded` row.
  4. Starts the Temporal `extractionWorkflow`
     (`apps/api/src/routes/provider.ts:151-162`) with
     `workflowId: extract-<documentId>` on
     `env().TEMPORAL_TASK_QUEUE`.
- **Summary:** finalize a presigned upload into a real `documents` row and
  kick the extraction workflow. **Note:** the Temporal `start` call here is
  the blocker that makes finalize fail in the no-worker stack — see §4.

### 1.4 `GET /provider/case/:caseId`

- **File:line:** `apps/api/src/routes/provider.ts:169-236`
- **Auth:** `requireProviderAuth` + `requireProviderTenancy`. Additional
  guard at line 174: `caseId` path param must match `auth.session.caseId`,
  else 403.
- **Request body:** none.
- **Response shape (verbatim from handler):**
  ```ts
  {
    case: {
      id, status, specialty, purpose,
      targetSubmissionDate
    },
    documents: Array<{
      id,
      documentType,
      extractionStatus,
      originalFilename,
      uploadedAt,
      expiresAt,
      confirmedAt,
      fields: ExtractedField[] | null, // raw extracted_fields jsonb
      already_on_file: boolean
    }>
  }
  ```
- **Side effects:** none (read-only).
- **Summary:** returns the case row plus all of the provider's documents
  (with a heuristic `already_on_file` flag based on `uploadedAt <
  case.openedAt && (!expiresAt || expiresAt > now)`).

### 1.5 `POST /provider/documents/:documentId/confirm`

- **File:line:** `apps/api/src/routes/provider.ts:242-300`
- **Auth:** `requireProviderAuth` + `requireProviderTenancy`. Also asserts
  the document belongs to the session's `providerId`
  (`apps/api/src/routes/provider.ts:257-264`).
- **Request body (zod):**
  ```ts
  z.object({ fields: ExtractedFieldsSchema })
  // ExtractedFieldsSchema = array of:
  //   { name: string,
  //     value: string|number|boolean|null,
  //     confidence: number(0..1),
  //     page: number(int >= 0),
  //     bbox: [number, number, number, number] }
  ```
  Source: `packages/types/src/domain/extraction.ts:7-17`.
- **Response:** `{ ok: true }`; 404 when the doc/provider don't match.
- **Side effects:** updates `documents.extractedFields`, sets
  `confirmedAt = now`, `extractionStatus = "succeeded"`; writes
  `audit.document.confirmed`.
- **Summary:** provider-side commit of the extracted fields after they
  review them on the confirm page.

### 1.6 Demo auth (relevant to the provider flow)

- **`POST /auth/dev/demo-signin-provider`** —
  `apps/api/src/routes/demoAuth.ts:128-189`. Anonymous (gated on
  `DEMO_AUTH_ENABLED=true`). Body: `{ caseId: uuid }`. Mints a real
  provider session bound to `(providerId, caseId, workspaceId)` for the
  case, sets `cred_sid`. **Today returns `{ ok, redirectPath: "/case/demo"
  }`** — the FE follows that and lands on fixture data instead of the
  real case. The intent is to flip to `redirectPath: "/case/<real-caseId>"`
  once the FE-expected `GET /v1/cases/<id>` endpoint exists.

### 1.7 What is *not* on the provider surface (gaps the FE relies on)

- No `GET /v1/cases/<id>` (the FE's `getCaseState`).
- No `POST /v1/cases/<id>/documents/sign-upload` (today the FE BFF maps to
  `/provider/uploads/initiate`; FE-direct callers would 404).
- No `POST /v1/cases/<id>/documents/<docId>/uploaded` (FE BFF maps to
  `/provider/uploads/complete`; same caveat).
- No `GET /v1/cases/<id>/documents/<docId>` (single-document poll).
- No `POST /v1/cases/<id>/documents/<docId>/confirm` (the FE BFF in
  `apps/web/app/api/cases/[caseId]/documents/[docId]/confirm/route.ts:33`
  calls `confirmExtractedFields` which hits this URL via `apiFetch`).
- No `POST /v1/cases/<id>/documents/reuse`.
- No `GET|POST /v1/cases/<id>/references`, no
  `DELETE /v1/cases/<id>/references/<refId>`.
- No `POST /v1/cases/<id>/attestation/sign`.
- No `POST /v1/cases/<id>/ready`.

---

## 2. FE-expected endpoints — coverage matrix

The list below was enumerated from `apps/web/lib/api/*.ts` and the BFFs
under `apps/web/app/api/cases/[caseId]/*`. URLs marked "via BFF" are
already wired through the FE same-origin proxy and only need the upstream
backend route. URLs without "via BFF" are called from server components
directly with `apiFetch(url, { token: cookie })`, which targets
`${env.API_BASE_URL}${url}` (no path rewriting).

| # | FE call | Backend route today | Coverage |
| - | ------- | ------------------- | -------- |
| 1 | `GET /v1/cases/<id>` (`apps/web/lib/api/cases.ts:22`) | `GET /provider/case/<id>` (different shape) | yellow — shape mismatch |
| 2 | `POST /v1/cases/<id>/ready` (`apps/web/lib/api/cases.ts:86`) | none | red — missing |
| 3 | `POST /v1/cases/<id>/documents/sign-upload` (`apps/web/lib/api/documents.ts:14`) | `POST /provider/uploads/initiate` (different shape; FE BFF reshapes it at `apps/web/app/api/cases/[caseId]/documents/sign-upload/route.ts:82-108`) | yellow — alias + adapter exists in BFF; backend path itself is missing |
| 4 | `POST /v1/cases/<id>/documents/<docId>/uploaded` (`apps/web/lib/api/documents.ts:26`) | `POST /provider/uploads/complete` (different shape; FE BFF reshapes at `apps/web/app/api/cases/[caseId]/documents/[docId]/uploaded/route.ts:64-91`) | yellow — alias + adapter exists in BFF; backend path missing |
| 5 | `GET /v1/cases/<id>/documents/<docId>` (`apps/web/lib/api/documents.ts:37`) | none | red — missing |
| 6 | `POST /v1/cases/<id>/documents/<docId>/confirm` (`apps/web/lib/api/documents.ts:46`) | `POST /provider/documents/<docId>/confirm` (different field schema; no FE BFF adapter today — the FE BFF in `documents/[docId]/confirm/route.ts:33` calls `confirmExtractedFields` which goes straight to `apiFetch /v1/cases/<id>/documents/<id>/confirm`) | yellow — backend path missing AND field schema differs |
| 7 | `POST /v1/cases/<id>/documents/reuse` (`apps/web/lib/api/documents.ts:59`) | none | red — missing |
| 8 | `GET /v1/cases/<id>/references` (`apps/web/lib/api/references.ts:8`) | none | red — missing |
| 9 | `POST /v1/cases/<id>/references` (`apps/web/lib/api/references.ts:16`) | none | red — missing |
| 10 | `DELETE /v1/cases/<id>/references/<refId>` (`apps/web/lib/api/references.ts:28`) | none | red — missing |
| 11 | `POST /v1/cases/<id>/attestation/sign` (`apps/web/lib/api/attestation.ts:14`) | none (cockpit-side `POST /cockpit/cases/<id>/attestations/send` is staff-only — `apps/api/src/routes/attestations.ts:18`) | red — missing (the underlying DocuSign envelope creation exists in `@cred/auth`, but no provider-facing route) |

What to do for each (specifics in §6):

### Row 1 — `GET /v1/cases/<id>` (yellow)

Today `/provider/case/<id>` returns a tiny shape (case + documents). The
FE's `CaseState` (`apps/web/lib/types/case.ts:42-65`) is much richer:
provider name, facility/workspace assignment, step list, required-document
slots (with `reusable` and `current` per type), references, attestation.
**Recommendation:** add a new endpoint `GET /v1/cases/<id>` that returns
the full `CaseState` shape. Leave `/provider/case/<id>` in place as the
low-level read used by anything that just needs the raw documents.

### Row 2 — `POST /v1/cases/<id>/ready` (red)

The FE calls this from `markCaseReady` (`apps/web/lib/api/cases.ts:82`)
but never wires it into the UI flow I could find in the (provider) pages
— the status page only polls. **Recommendation:** stub a route that
verifies the case is in `awaiting_provider`, asserts the required-document
checklist is complete, flips `cases.status` to `ready_for_review`, and
writes an `audit` row. **Effort:** S.

### Row 3 — `POST /v1/cases/<id>/documents/sign-upload` (yellow)

The FE BFF already proxies `/provider/uploads/initiate` and reshapes the
response (mapping `uploadId` → `documentId` and stripping `expiresAt`,
`originalFilename`). The cleanest move is to **add an alias backend route
that returns the FE-shaped response directly**, removing the BFF reshape
hack. That alias should also:
- accept `{ documentType, mimeType, sizeBytes? }` (today the BE accepts
  only `contentType`),
- persist `documentType` and `sizeBytes` so the `documents` row created in
  step 4 carries the FE's typed guess (today the row is always inserted
  with `documentType: "other"` and rewritten by the classifier).
- The cleanest implementation is to **write the `documents` row up-front**
  here (status `pending`, `documentType` from request) and return its real
  UUID as `documentId`. That eliminates the awkward "uploadId carries
  through as documentId" handoff between sign-upload and uploaded.

### Row 4 — `POST /v1/cases/<id>/documents/<docId>/uploaded` (yellow)

Today the FE BFF translates this to `/provider/uploads/complete`, passing
the upload-key-as-docId. The response is reshaped to a stub
`DocumentSummary`. **Recommendation:** add a new backend route that:
1. Looks up the `documents` row by id, asserts provider ownership.
2. Verifies the underlying S3 object exists.
3. Flips `extractionStatus` from `pending` to `running` and **kicks
   extraction (inline preferred — see §4)**.
4. Returns the full `DocumentSummary` shape (id, type, thumbnailUrl=null,
   pageCount, uploadedAt, expiresAt, extractionStatus,
   reusedFromPriorCase=false, extractedFields=undefined).

### Row 5 — `GET /v1/cases/<id>/documents/<docId>` (red)

Used in `apps/web/lib/api/documents.ts:37` but I don't see a FE caller in
the provider flow today. It would be the right shape for the confirm-page
polling loop (currently the confirm page renders fixtures and never
polls — `apps/web/app/(provider)/case/[caseId]/document/[docType]/confirm/[docId]/page.tsx:30`).
**Recommendation:** ship it — return a `DocumentSummary`. The confirm
page can then poll until `extractionStatus === "ready"` before showing
real fields. **Effort:** S.

### Row 6 — `POST /v1/cases/<id>/documents/<docId>/confirm` (yellow)

Two problems:

1. **Path:** today the backend exposes
   `/provider/documents/<docId>/confirm`. Add a new route at the FE
   path or an alias.
2. **Schema:** the FE field shape is
   `{ key, label, value: string, confidence }` (no page, no bbox required,
   value forced to string) — see
   `apps/web/lib/types/document.ts:99-110` and the BFF zod schema at
   `apps/web/app/api/cases/[caseId]/documents/[docId]/confirm/route.ts:6-15`.
   The BE schema is the canonical
   `{ name, value: union, confidence, page, bbox }` — see
   `packages/types/src/domain/extraction.ts:7-13`.

**Recommendation:** the FE shape is a lossy projection; the new alias
should accept the FE shape and **map it to the canonical shape on the
backend** (key → name, drop label, default page=0 and bbox=[0,0,1,0.1]).
Do not change the BE canonical shape — extractors emit it and the cockpit
preview reads it (`apps/api/src/routes/packet.ts:159-189`).

### Row 7 — `POST /v1/cases/<id>/documents/reuse` (red)

The FE wants to "reuse a prior document on this case" instead of
re-uploading. Implementation: insert a new `documents` row that points at
the same `fileUri`/`contentHash`/`extractedFields` as the source row, but
with this case's `providerId`, `documentType` from the body, and
`source: "provider_upload"` (or add a new `documentSourceEnum` value
`reused_from_prior_case`). Return the new `DocumentSummary`.

### Row 8 — `GET /v1/cases/<id>/references` (red)

Read the `references` table where `caseId = <id>` and shape into
`ReferenceSummary[]` (`apps/web/lib/types/reference.ts:9-18`).

### Row 9 — `POST /v1/cases/<id>/references` (red)

Insert into `references` with `workspaceId = session.caseWorkspaceId`,
status=`pending`. Body shape:
`{ fullName, email, organization, relationship }` (FE — note FE uses
`fullName` and `organization`; BE table has `name` and no `organization`
column, see §3.3).

### Row 10 — `DELETE /v1/cases/<id>/references/<refId>` (red)

Soft-delete vs. hard-delete is a product decision; recommendation is a
hard delete with an audit row, since references are pre-completion
contacts and there's no downstream FK that would break.

### Row 11 — `POST /v1/cases/<id>/attestation/sign` (red)

Provider-side equivalent of the cockpit's `POST
/cockpit/cases/<id>/attestations/send` route
(`apps/api/src/routes/attestations.ts:18-99`). Same `createAttestationEnvelope`
call, but the provider initiates it themselves with a `returnUrl`. Out
of scope per audit constraints (DocuSign deferred) — recommend stubbing a
501 or returning a fake `signingUrl` for staging.

---

## 3. Shape mismatches in detail

### 3.1 `getCaseState` — `CaseState` vs `GET /provider/case/<id>` response

**FE expects (`apps/web/lib/types/case.ts:42-65`):**

```ts
interface CaseState {
  id: string;
  status: CaseStatus;       // 9-value union (see below)
  assignment: {
    facilityName: string;
    workspaceName: string;
    specialty: string;
    targetSubmissionDate: string | null;
  };
  providerFirstName: string;
  steps: Array<{
    kind: "welcome"|"document"|"references"|"attestation"|"review"|"submitted";
    index: number;
    label: string;
    complete: boolean;
    documentType?: DocumentType;
  }>;
  requiredDocuments: Array<{
    type: DocumentType;
    reusable?: DocumentSummary;
    current?: DocumentSummary;
  }>;
  references: ReferenceSummary[];
  attestation: { required: boolean; signed: boolean; signingUrl?: string };
}
```

**BE returns (`apps/api/src/routes/provider.ts:226-235`):**

```ts
{
  case: { id, status, specialty, purpose, targetSubmissionDate },
  documents: Array<{
    id, documentType, extractionStatus, originalFilename,
    uploadedAt, expiresAt, confirmedAt, fields, already_on_file
  }>
}
```

**Field-level diffs:**

- `assignment.facilityName` — not returned. Comes from `facilities` joined
  through `cases.facilityProfileId → facility_profiles.facilityId →
  facilities.name`.
- `assignment.workspaceName` — not returned. From
  `workspaces.name` (`auth.session.caseWorkspaceId`).
- `assignment.specialty` — present on BE as `case.specialty` (good).
- `assignment.targetSubmissionDate` — present (`case.targetSubmissionDate`).
- `providerFirstName` — not returned. From
  `providers.first_name` (`auth.session.providerId`).
- `status` — **enum mismatch**.
  FE union (`apps/web/lib/types/case.ts:4-13`): `intake | documents_pending
  | documents_review | references_pending | attestation_pending |
  ready_to_submit | submitted | active | closed`. BE union
  (`packages/types/src/domain/enums.ts:7-17`): `intake | in_progress |
  awaiting_provider | awaiting_references | ready_for_review | submitted
  | completed | withdrawn`. The new `/v1/cases/<id>` endpoint must
  **translate** the BE status into the FE-expected vocabulary (best-effort
  table; recommendation):
  - `intake` → `intake`
  - `in_progress` → `documents_review`
  - `awaiting_provider` → `documents_pending`
  - `awaiting_references` → `references_pending`
  - `ready_for_review` → `ready_to_submit`
  - `submitted` → `submitted`
  - `completed` → `closed`
  - `withdrawn` → `closed`
- `steps[]` — entirely synthesized; doesn't exist on the BE today. Build
  from the facility profile's `requirements.required_documents`, the
  attestation list, and the references count (see fixture in
  `apps/web/lib/fixtures/case.ts` for the exact pattern).
- `requiredDocuments[]` — derived from the facility profile's
  `required_documents` cross-joined with `documents` for that provider.
  Today `/provider/case/<id>` returns *all* the provider's documents and
  shells out the "which doc fulfills which requirement" matching to the
  FE.
- `references[]` — not returned. From the `references` table where
  `caseId = case.id`.
- `attestation` — not returned. `required` is `requirements.attestations.length > 0`;
  `signed` is `attestations` row where caseId match has `status =
  "completed"`.
- `documents[].fields` on BE is the raw `extracted_fields` jsonb (FE-canonical
  `{ name, value, confidence, page, bbox }` — see §3.2). FE
  `DocumentSummary.extractedFields` wants `{ key, label, value: string,
  confidence }`.
- `documents[].already_on_file: boolean` — BE-only; FE expresses the same
  idea as `reusable?: DocumentSummary` on the per-requirement slot.

### 3.2 Document type vocabulary mismatch

BE `DOCUMENT_TYPES` (`packages/types/src/domain/enums.ts:46-58`):
`medical_license | dea | board_certification | bls | acls |
medical_school_diploma | government_id | vaccination_record |
malpractice_insurance | cv | other`.

FE `DOCUMENT_TYPES` (`apps/web/lib/types/document.ts:9-19`):
`medical_license | dea | board_certification | bls | acls |
medical_diploma | government_id | vaccination | malpractice_insurance`.

Diffs:
- BE `medical_school_diploma` vs FE `medical_diploma`.
- BE `vaccination_record` vs FE `vaccination`.
- BE has `cv` and `other`; FE has neither.

**Impact:** today the BFF translation in
`apps/web/app/api/cases/[caseId]/documents/[docId]/uploaded/route.ts:88`
hard-codes `documentType: "other"` on the FE response. Once `documents`
rows carry a real `documentType` from the classifier, the new
`/v1/cases/<id>/...` endpoints will need a translation layer in both
directions. Cheapest fix: have the new endpoints map BE → FE on the way
out and FE → BE on the way in. Long-term: align the enums.

### 3.3 `ExtractedField` schema (FE vs BE)

**FE (`apps/web/lib/types/document.ts:99-110`):**

```ts
interface ExtractedField {
  key: string;
  label: string;
  value: string;                    // forced to string
  confidence: number;
  bbox?: { page: number; bbox: [number, number, number, number] };
}
```

**BE (`packages/types/src/domain/extraction.ts:7-13`):**

```ts
ExtractedFieldSchema = z.object({
  name: z.string(),                  // FE's "key"
  value: z.union([string, number, boolean, null]),
  confidence: z.number().min(0).max(1),
  page: z.number().int().nonnegative(),
  bbox: [number, number, number, number],
});
```

**Adapter needed (both directions, in the new alias endpoints):**

- **BE → FE on read:** `key = field.name`, `label = humanize(field.name)`,
  `value = String(field.value ?? "")`, `confidence`,
  `bbox = { page: field.page, bbox: field.bbox }`.
- **FE → BE on confirm:** `name = field.key`, `value = field.value`,
  `confidence`, `page = field.bbox?.page ?? 0`,
  `bbox = field.bbox?.bbox ?? [0, 0, 1, 0.1]`.

### 3.4 References shape

**FE (`apps/web/lib/types/reference.ts:9-18`):**

```ts
{ id, fullName, email, organization, relationship, status, completedAt }
```

**BE `references` table (`packages/db/src/schema/outreach.ts:57-79`):**

```ts
{ id, workspaceId, caseId, name, relationship, email, phone, status,
  responseFields, respondedAt, createdAt }
```

Diffs:
- FE `fullName` ↔ BE `name`.
- FE has `organization` (string) — **the column does not exist** on
  `references`. Options: add a column or stash it in
  `responseFields` (preferred for the v1 ship: it's metadata, not
  outreach-critical).
- FE `completedAt` ↔ BE `respondedAt`.
- BE `phone` is not surfaced to the FE; that's fine.

### 3.5 `DocumentSummary` shape (used everywhere documents return)

**FE (`apps/web/lib/types/document.ts:112-124`):**

```ts
{ id, type: DocumentType, thumbnailUrl: string|null, pageCount: number,
  uploadedAt: string, expiresAt: string|null,
  extractionStatus: "pending"|"processing"|"ready"|"failed",
  extractedFields?: ExtractedField[],
  reusedFromPriorCase: boolean }
```

**BE `documents` table:** has every column except `thumbnailUrl` and
`reusedFromPriorCase`. Maps:
- BE `extractionStatus` ∈ `pending | running | succeeded | needs_review | failed`
  vs FE `pending | processing | ready | failed`. Adapter table:
  `pending → pending`, `running → processing`,
  `succeeded → ready`, `needs_review → ready` (FE has no separate review
  signal — confirm-page UI handles low confidence per-field via the
  `confidence` value), `failed → failed`.
- BE `documentType` enum → FE `documentType` enum: see §3.2 translations.
- `thumbnailUrl`: null always for v1 (no thumbnailer service yet).
- `reusedFromPriorCase`: derivable from `source` (true if `source` is the
  new `reused_from_prior_case` if added, otherwise false).

---

## 4. Extraction pipeline status

### 4.1 Facility ingest — inline replacement of Temporal

`apps/api/src/services/facilityIngestJob.ts:21-144` defines
`advanceIngestJobInline(jobId)`. It walks an `ingest_jobs` row through
`uploaded → classifying → parsing → ready` in the API process:

1. Loads the job (rls: bypass).
2. Updates status to `classifying`.
3. Pulls the PDF from object storage with a 10-min signed GET URL, fetches
   it, base64-encodes it.
4. Updates status to `parsing`.
5. Calls `parseFacilityPacket` (`@cred/ai`, see
   `packages/ai/src/facilityParser.ts`) — this is the Opus call.
6. Computes the next `facility_profiles.version` and inserts a `draft`
   profile.
7. Flips the job to `ready` with `facilityProfileId`.
8. Writes `audit.facility_profile.drafted`.
9. On any failure: marks the job `failed` with a bounded `error` string.

This is the upload-flow equivalent of what the Temporal `facilityIngest`
workflow does for the email-in path
(`apps/workers/src/workflows/facilityIngest.ts`,
`apps/workers/src/activities/facilityIngest.ts`).

### 4.2 Document extraction — Temporal workflow only

`apps/workers/src/workflows/extraction.ts` defines `extractionWorkflow`
(`extractionWorkflow:24-72`). It chains four activities defined in
`apps/workers/src/activities/extraction.ts`:

1. `virusScanActivity` — stub today (only confirms the doc row exists).
2. `classifyActivity` — calls `@cred/ai` `classifyDocument({ imageUrl, … })`
   against a signed GET URL.
3. `extractActivity` — calls `@cred/ai` `extractByType(documentType,
   [signedUrl], …)`, returns `{ fields, averageConfidence }`.
4. `persistExtractionActivity` — sets `documentType`,
   `classifierConfidence`, `extractedFields`, `extractedAt`,
   `contentHash`, and `extractionStatus` ∈ `succeeded | needs_review`
   based on average confidence thresholds (0.9 / 0.7). Writes
   `audit.document.extracted`.

This workflow is started **synchronously from the API handler** in
`apps/api/src/routes/provider.ts:151-162` (`client.workflow.start(...)` is
fire-and-forget but still requires the Temporal server to accept the
call). The connection is made via
`apps/api/src/services/temporal.ts:7-12` against `env().TEMPORAL_ADDRESS`.

### 4.3 Worker container disabled — and what fails because of it

`compose.yml:127-162` keeps the `worker` service behind
`profiles: [worker]`. With no worker:
- `client.workflow.start("extractionWorkflow", …)` queues the workflow on
  Temporal but **nothing dequeues it**. The handler returns 200 with
  `extractionStatus: "pending"` and that row stays `pending` forever.
- The FE confirm page already short-circuits this by rendering fixture
  fields (`apps/web/app/(provider)/case/[caseId]/document/[docType]/confirm/[docId]/page.tsx:64-93`),
  so the demo flow looks OK end-to-end — but the production flow is
  broken until either the worker comes back or the API does the extraction
  inline.

### 4.4 Recommendation: inline document extraction

Reason: the inline facility-ingest pattern already exists, the Opus
extraction code is already in `@cred/ai` (it's the same code the worker
calls), and the worker is blocked on a native-binary ARM problem with a
clean workaround. Mirroring `advanceIngestJobInline` keeps the demo stack
single-process and eliminates the "did the worker run" failure mode.

Sketch — new file `apps/api/src/services/documentExtractionInline.ts`:

```ts
export async function advanceDocumentExtractionInline(
  documentId: string,
  workspaceId: string,
): Promise<void> {
  // 1. mark extractionStatus = "running"
  // 2. classifyDocument({ imageUrl, workspaceId, documentId })
  // 3. extractByType(documentType, [signedUrl], { workspaceId, documentId })
  // 4. persist fields + status (mirror persistExtractionActivity)
  // 5. audit("document.extracted")
  // on error: extractionStatus = "failed" + audit("document.extraction_failed")
}
```

All four activities in `apps/workers/src/activities/extraction.ts` already
do `rls: bypass` reads keyed on `documentId` — the code can be lifted
into the API process essentially verbatim. Wire it into:
- the new `POST /v1/cases/<id>/documents/<docId>/uploaded` (kick the
  inline runner from the request handler, **don't await** — return 200
  with `extractionStatus: "running"` immediately and rely on the FE poll).
- the legacy `POST /provider/uploads/complete` (replace the
  `client.workflow.start` call).

A `setImmediate` or detached promise is fine here — the activity already
catches its own errors and updates the doc row's status to `failed` on
exception. (For a future hardening pass, push to a Redis queue or
pgmq — the Postgres image we already run is `tembo/pg16-pgmq`, so
`pgmq` is sitting there free — but that's not needed for the demo
stack.)

### 4.5 If we instead fix the Temporal worker

The compose comment names the path: bump
`@temporalio/{client,worker,workflow,activity}` from `1.11.5` to
`>=1.13.x` (which ships the relocated native binary for current
debian-slim glibc). Steps would be:

1. `pnpm up @temporalio/client@^1.13 @temporalio/worker@^1.13
   @temporalio/workflow@^1.13 @temporalio/activity@^1.13`.
2. `pnpm install` and let pnpm regenerate the platform-specific binary.
3. Remove `profiles: [worker]` from `compose.yml:140`.
4. `docker compose up -d worker` and watch the boot.

Risk: 1.11 → 1.13 has a couple of API renames (the worker `Worker.create`
signature is stable but `proxyActivities`'s defaults changed). The
upgrade is real engineering work — probably an L item — and it doesn't
buy us anything the inline path doesn't already give us for the demo
stack.

**Recommendation: ship inline first (mirror facility ingest), defer the
Temporal upgrade to a separate workstream.**

---

## 5. Tenancy + RLS considerations

All proposed `/v1/cases/*` endpoints sit on the provider surface (a
provider session, not staff). Middleware wiring is the same as today's
`/provider/*` block:

```ts
app.use("/v1/cases/*", requireProviderAuth, requireProviderTenancy);
```

…**and** each handler must defensively check `params.caseId ===
auth.session.caseId` (see the existing pattern at
`apps/api/src/routes/provider.ts:174-179`). Without this, a provider with
a valid session for *their* case could fetch a different case in the
same workspace by guessing the UUID. `requireProviderTenancy` only binds
`tenancy.workspaceId`; it does not constrain by case.

Per-endpoint notes:

| Endpoint | Middleware | RLS bypass needed? | Cross-workspace leak risk |
| --- | --- | --- | --- |
| `GET /v1/cases/<id>` | provider auth + provider tenancy + caseId-eq guard | no — `withTenancy` covers cases/documents/refs/attestations; facility name lookup needs a one-off read into the `facilities` table by id (rls: bypass — facilities are global, no PHI). Workspace name lookup similarly bypass. | low if caseId guard is enforced |
| `POST /v1/cases/<id>/ready` | provider auth + provider tenancy + caseId-eq guard | no | low |
| `POST /v1/cases/<id>/documents/sign-upload` | provider auth + provider tenancy + caseId-eq guard | no | low — no DB read needed before signing |
| `POST /v1/cases/<id>/documents/<docId>/uploaded` | provider auth + provider tenancy + caseId-eq + document ownership (providerId match) guards | no | low |
| `GET /v1/cases/<id>/documents/<docId>` | same as above | no | low |
| `POST /v1/cases/<id>/documents/<docId>/confirm` | same as above | no | low (identical to existing `/provider/documents/<id>/confirm`) |
| `POST /v1/cases/<id>/documents/reuse` | provider auth + provider tenancy + caseId-eq + reusedDocumentId ownership guard (must belong to same providerId) | no | medium — without the ownership check a provider session could reuse a document owned by *another* provider in the same workspace. Always assert `documents.providerId === session.providerId` for the reusedDocumentId. |
| `GET\|POST\|DELETE /v1/cases/<id>/references[/<refId>]` | provider auth + provider tenancy + caseId-eq guard + (DELETE) reference.caseId match | no | low |
| `POST /v1/cases/<id>/attestation/sign` | provider auth + provider tenancy + caseId-eq guard | no | low |

The shared invariant: **case-bound provider sessions only ever touch
their own case, their own provider's documents, and their own case's
references.** Encode this as a small `assertSessionOwnsCase(c, caseId)`
helper to avoid drift.

---

## 6. Implementation plan

Items are ordered so each is testable on its own with the demo provider
session cookie. Get the cookie by:

```bash
curl -i -c /tmp/cred.cookies \
  -H 'content-type: application/json' \
  -d '{"caseId":"22222222-cccc-4444-8888-000000000002"}' \
  http://localhost:3001/auth/dev/demo-provider-signin
```

…then `-b /tmp/cred.cookies` on every subsequent call.

### 6.1 Add `assertSessionOwnsCase(c, caseId)` helper — S

- **File:** new helper in `apps/api/src/middleware/tenancy.ts` (or
  `apps/api/src/routes/_providerHelpers.ts`).
- **What:** centralise the 403-on-mismatch check used today at
  `apps/api/src/routes/provider.ts:174-179`. Both old and new routes call
  the same helper.
- **Depends on:** nothing.
- **Test:** call any provider route with a tampered `:caseId` path
  param, expect 403.

### 6.2 Add `documentExtractionInline` service — M

- **File:** new `apps/api/src/services/documentExtractionInline.ts`.
- **What:** mirror `advanceIngestJobInline`. Steps: load doc by id (rls
  bypass), flip to `running`, classify via `classifyDocument`, extract via
  `extractByType`, persist (writing `documentType`, `extractedFields`,
  `extractionStatus`, `extractedAt`, `contentHash`,
  `classifierConfidence`), audit `document.extracted`. On error: mark
  `failed`, audit `document.extraction_failed`. Lift the helper code
  directly from `apps/workers/src/activities/extraction.ts`.
- **Depends on:** nothing (`@cred/ai` already exports
  `classifyDocument` + `extractByType` — see
  `packages/ai/src/index.ts:3-17`).
- **Test:** call the existing `/provider/uploads/complete`, then poll
  the documents table; row should transition `pending → running →
  succeeded` (or `needs_review`) within a few seconds, without the
  Temporal worker running.

### 6.3 Rewire `/provider/uploads/complete` to use inline extraction — S

- **File:** `apps/api/src/routes/provider.ts:151-162`.
- **What:** replace the `client.workflow.start("extractionWorkflow", …)`
  call with a fire-and-forget `void advanceDocumentExtractionInline(…)`.
- **Depends on:** 6.2.
- **Test:** same as 6.2 — but exercised through the old route.

### 6.4 Add `POST /v1/cases/<id>/documents/sign-upload` (FE-shaped alias) — M

- **File:** new handler in `apps/api/src/routes/provider.ts` (or split
  into `routes/cases.ts` if growing).
- **What:** insert a `documents` row up-front with the FE-supplied
  `documentType` (mapped through the §3.2 translator — fall back to
  `other` if no match), `extractionStatus: "pending"`, generate a fresh
  `documentId`, sign the upload URL keyed
  `uploads/<caseId>/<documentId>`. Response: `{ documentId, uploadUrl,
  headers, maxBytes: 25 * 1024 * 1024 }` per
  `apps/web/lib/types/document.ts:126-133`.
- **Depends on:** 6.1.
- **Test:**

```bash
curl -s -b /tmp/cred.cookies -H 'content-type: application/json' \
  -d '{"documentType":"medical_license","mimeType":"image/jpeg","sizeBytes":1024}' \
  http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002/documents/sign-upload
```

### 6.5 Add `POST /v1/cases/<id>/documents/<docId>/uploaded` (FE-shaped alias) — M

- **File:** same file as 6.4.
- **What:** assert document ownership (providerId match), assert object
  exists in storage, flip `extractionStatus` to `running`, kick
  `advanceDocumentExtractionInline` (no await), return a `DocumentSummary`
  with `extractionStatus: "processing"`.
- **Depends on:** 6.1, 6.2, 6.4.
- **Test:** PUT a real JPEG to the signed URL from 6.4, then:

```bash
curl -s -b /tmp/cred.cookies -X POST \
  http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002/documents/<docId>/uploaded
```

…and verify the `documents` row transitions.

### 6.6 Add `GET /v1/cases/<id>/documents/<docId>` — S

- **File:** same as 6.4.
- **What:** read one doc by id, assert ownership, project into
  `DocumentSummary` shape (status mapping per §3.5, doctype mapping per
  §3.2, fields adapter per §3.3).
- **Depends on:** 6.1.
- **Test:**

```bash
curl -s -b /tmp/cred.cookies \
  http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002/documents/33333333-dddd-4444-8888-000000000004
```

…expect the Daniel Cohen medical license document with `extractionStatus:
"ready"` and four extracted fields.

### 6.7 Add `POST /v1/cases/<id>/documents/<docId>/confirm` (FE-shaped) — S

- **File:** same as 6.4.
- **What:** accept FE-shape `{ fields: Array<{ key, label, value: string,
  confidence, bbox? }> }`. Translate via the §3.3 adapter to the canonical
  shape and call the same DB update path as the existing
  `/provider/documents/<id>/confirm`. Return the updated `DocumentSummary`
  (FE-shape) instead of `{ ok: true }`.
- **Depends on:** 6.1, 6.6 (for the response projection).
- **Test:**

```bash
curl -s -b /tmp/cred.cookies -X POST -H 'content-type: application/json' \
  -d '{"fields":[{"key":"license_number","label":"License number","value":"NY-887421","confidence":0.97}]}' \
  http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002/documents/33333333-dddd-4444-8888-000000000004/confirm
```

### 6.8 Add `POST /v1/cases/<id>/documents/reuse` — S

- **File:** same as 6.4.
- **What:** look up source `documents` row, assert ownership, insert new
  row copying `fileUri`, `contentHash`, `extractedFields`, `mimeType`,
  `pageCount`, `expiresAt`, `documentType` (or override from body),
  `extractionStatus: "succeeded"`, `confirmedAt: now()`, `source:
  "provider_upload"` (or new `reused_from_prior_case` enum value once
  added). Return `DocumentSummary` with `reusedFromPriorCase: true`.
  Audit `document.reused`.
- **Depends on:** 6.1.
- **Test:** seed has Daniel's existing medical license at
  `33333333-dddd-4444-8888-000000000004`; reuse it onto the same case
  (which will be a no-op for case linkage today since `documents` aren't
  caseId-scoped — but the row will exist and re-flow through the FE).

### 6.9 Add `GET /v1/cases/<id>/references` — S

- **File:** new `apps/api/src/routes/casesReferences.ts` or extend the
  provider router.
- **What:** select from `references` where `caseId = <id>` and
  `workspaceId = tenancy.workspaceId` (RLS-safe via `withTenancy`), map
  to `ReferenceSummary[]` (`fullName: r.name`, `organization:
  r.responseFields?.organization ?? ""`, `completedAt: r.respondedAt`).
- **Depends on:** 6.1.
- **Test:**

```bash
curl -s -b /tmp/cred.cookies \
  http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002/references
```

…expect `[]` for case 2 (no seeded refs).

### 6.10 Add `POST /v1/cases/<id>/references` — S

- **File:** same as 6.9.
- **What:** insert into `references` with `name: body.fullName`,
  `responseFields: { organization: body.organization }`,
  `relationship: body.relationship`, `email`, `status: "pending"`.
  Audit `reference.invited`. Return `ReferenceSummary`.
- **Depends on:** 6.1, 6.9.
- **Test:**

```bash
curl -s -b /tmp/cred.cookies -X POST -H 'content-type: application/json' \
  -d '{"fullName":"Dr. Jane Doe","email":"jane.doe@example.org","organization":"NYU","relationship":"department_chair"}' \
  http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002/references
```

### 6.11 Add `DELETE /v1/cases/<id>/references/<refId>` — S

- **File:** same as 6.9.
- **What:** delete the row where `id = refId AND caseId = caseId AND
  workspaceId = tenancy.workspaceId`. Audit `reference.removed`. Return
  204.
- **Depends on:** 6.1, 6.9.
- **Test:** invite a reference (6.10), then DELETE.

### 6.12 Add `POST /v1/cases/<id>/ready` — S

- **File:** new `apps/api/src/routes/casesActions.ts` or same as 6.4.
- **What:** assert the case is in `awaiting_provider`; flip
  `cases.status` to `ready_for_review`. Audit `case.marked_ready_by_provider`.
- **Depends on:** 6.1.
- **Test:**

```bash
curl -s -b /tmp/cred.cookies -X POST \
  http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002/ready
```

### 6.13 Add `POST /v1/cases/<id>/attestation/sign` — M

- **File:** new handler in `apps/api/src/routes/attestations.ts`.
- **What:** call `createAttestationEnvelope` from `@cred/auth` for the
  case's first required attestation (or all of them — TBD with the FE);
  insert `attestations` row(s); return `{ signingUrl, envelopeId }` per
  `apps/web/lib/api/attestation.ts:9-12`. **Deferred per audit constraints
  — for staging, return a fake `{ signingUrl:
  "https://example.com/sign?envelope=stub", envelopeId: "stub" }`** so the
  FE renders end-to-end.
- **Depends on:** 6.1.
- **Test:**

```bash
curl -s -b /tmp/cred.cookies -X POST -H 'content-type: application/json' \
  -d '{"returnUrl":"https://localhost/case/22222222-cccc-4444-8888-000000000002/attest"}' \
  http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002/attestation/sign
```

### 6.14 Add `GET /v1/cases/<id>` (the centerpiece) — L

- **File:** new handler in same file as 6.4 or its own
  `apps/api/src/routes/casesRead.ts`.
- **What:** the heaviest endpoint. In one `withTenancy` transaction:
  1. Load `cases` by id, assert ownership.
  2. Load `providers` by `case.providerId` (rls: bypass — providers is
     global per the schema comment in
     `packages/db/src/schema/providers.ts:5-7`).
  3. Load `facility_profiles` by `case.facilityProfileId` (rls: bypass on
     the join to `facilities.name`).
  4. Load `workspaces.name` by `tenancy.workspaceId`.
  5. Load all `documents` for `providerId` and partition by
     `documentType`.
  6. Load `references` by `caseId`.
  7. Load `attestations` by `caseId`.
  8. Compose:
     - `assignment`: facilityName, workspaceName, specialty, target date.
     - `providerFirstName`: from providers row.
     - `status`: translate enum per §3.1.
     - `requiredDocuments`: for each `facility_profiles.requirements
       .required_documents[i]`, look up the provider's documents of that
       type. The most recent unexpired doc becomes `current` if uploaded
       after `case.openedAt`, else `reusable`. Each `DocumentSummary`
       projection uses §3.5.
     - `steps`: synthesize from `[welcome] + [document per required type]
       + [references if attestations or refs needed] + [attestation if
       required] + [submitted]`. Per-doc `complete = current !== undefined
       && current.extractionStatus === "ready"`.
     - `references`: BE row → FE shape per §3.4.
     - `attestation`: `required = requirements.attestations.length > 0`,
       `signed = attestations.every(a => a.status === "completed")`,
       `signingUrl` omitted (set only when the provider has an open
       envelope; deferred until 6.13 is real).
- **Depends on:** 6.1, 6.6.
- **Test:**

```bash
curl -s -b /tmp/cred.cookies \
  http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002 | jq .
```

Expected: `assignment.facilityName === "Regions Hospital"` (or whatever
the seed names it), `providerFirstName === "Daniel"`,
`status === "documents_pending"`, four `requiredDocuments` (license, DEA,
board cert per the Regions seed at `scripts/seed-demo.sh:59`), license &
board_cert appear with `current` (extraction ready), DEA appears with
`current` (extractionStatus mapped from `pending` → `pending` and no
`extractedFields`).

### 6.15 Flip demo-provider-signin redirect — S

- **File:** `apps/api/src/routes/demoAuth.ts:187`.
- **What:** change `redirectPath: "/case/demo"` to `redirectPath:
  /case/${cs.id}`.
- **Depends on:** 6.14 (without `GET /v1/cases/<id>` working, the
  redirect lands on a 500).
- **Test:** click the demo card on `/signin`; the FE lands on
  `/case/22222222-...` and renders Daniel Cohen's real `CaseState`.

### 6.16 Add `current` slot wiring + DocumentChecklist render — verify only, S

- **File:** verify only — `apps/web/components/provider/DocumentChecklist.tsx`,
  `apps/web/lib/case/progress.ts` already consume `current` and `reusable`.
- **What:** smoke test that the FE chips switch from "Needed" to "On
  file" once a doc is uploaded.
- **Depends on:** 6.14.

---

## TLDR

- **16 items** in the implementation plan: 1 helper, 1 service, 1 rewire,
  10 new endpoints (3 of which alias-or-extend existing handlers), 1
  config flip, 1 FE verification.
- **Effort estimate:** roughly **S × 10 + M × 4 + L × 1**, so about **5 hours**
  of focused engineering, plus testing.
- **Recommended build order:**
  1. **Foundation (6.1, 6.2, 6.3):** ownership helper + inline document
     extraction + rewire the existing `/provider/uploads/complete` path.
     This decouples the audit from the Temporal worker and makes the
     existing demo flow's seeded extraction work for real (the seeded DEA
     `33333333-dddd-4444-8888-000000000006` is in `pending` — kicking the
     inline runner manually verifies the path).
  2. **Document loop (6.4 → 6.5 → 6.6 → 6.7):** add the four `/v1/cases/.../documents/*`
     routes in flow order so a single curl chain (sign → PUT → uploaded
     → poll GET → confirm) walks the whole upload.
  3. **Reuse + references + ready (6.8 → 6.9 → 6.10 → 6.11 → 6.12):**
     small, independent items.
  4. **Attestation stub (6.13):** unblocks the FE attest page.
  5. **`GET /v1/cases/<id>` (6.14):** the keystone — wait until 6.6 and
     6.7 are in so the `DocumentSummary` projection is reusable.
  6. **Flip the redirect (6.15) + FE smoke (6.16).**

Once 6.14 + 6.15 are merged, the FE's `/signin` demo card lands on
`/case/22222222-cccc-4444-8888-000000000002` and renders the full
provider walkthrough against real backend data — the original audit goal.
