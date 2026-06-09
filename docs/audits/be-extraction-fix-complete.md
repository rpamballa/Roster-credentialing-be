# BE Document-Extraction HTTPS-URL Fix — Validation Report

**Run date:** 2026-06-06
**Stack:** `~/IdeaProjects/roster-credentialing-deploy` (containerized;
`cred-deploy-api-1`, `cred-deploy-postgres-1`, `cred-deploy-minio-1`).
**Predecessor audit:** `docs/audits/be-fixes-complete.md` §2 (the Checkpoint A
"failed" terminal state).

The inline extractor now fetches the uploaded bytes from object storage and
hands them to Anthropic as inline base64 (mirroring `parseFacilityPacket`),
so the staging stack no longer dies at `400 Only HTTPS URLs are supported`.
Documents transition `pending → running → succeeded` with populated
`extracted_fields`, and the audit row says `document.extracted`.

---

## 1. Files changed

### `packages/ai/src/extractors/base.ts` — replace URL input with inline base64

- New exports:
  - `type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp"`
  - `type DocumentMediaType = "application/pdf"`
  - `type SupportedMediaType = ImageMediaType | DocumentMediaType`
  - `type DocumentContent = { base64: string; mediaType: SupportedMediaType }`
  - `function contentBlock(content)` — emits Anthropic `{type:"document", source:{type:"base64",...}}` for PDFs and `{type:"image", source:{type:"base64",...}}` for images.
- `ExtractParams.imageUrls: string[]` → `ExtractParams.contents: DocumentContent[]`.
- `runExtractor` now throws `"runExtractor requires at least one DocumentContent"` on empty input instead of sending a body-less request.
- System prompt updated to mention PDFs (not just page images).

### `packages/ai/src/classifier.ts` — same migration

- `ClassifyParams.imageUrl: string` → `ClassifyParams.content: DocumentContent`.
- Reuses `contentBlock()` so PDFs go through `{type:"document"}` and images through `{type:"image"}`.

### `packages/ai/src/extractors/index.ts`

- `ExtractorFn(imageUrls: string[], ...)` → `ExtractorFn(contents: DocumentContent[], ...)`.
- `extractByType(documentType, imageUrls, ...)` → `extractByType(documentType, contents, ...)`.
- Re-exports `DocumentContent`, `ImageMediaType`, `DocumentMediaType`, `SupportedMediaType` for downstream callers.

### `packages/ai/src/extractors/*.ts` — uniform parameter rename

All eight per-type extractors mechanically swapped `imageUrls: string[]` → `contents: DocumentContent[]` and `runExtractor({...imageUrls})` → `runExtractor({...contents})`. None required structural changes; the per-type SPEC blocks and prompts are unchanged.

- `license.ts`
- `dea.ts`
- `boardCert.ts`
- `bls.ts`
- `acls.ts`
- `diploma.ts`
- `governmentId.ts`
- `vaccinationRecord.ts`

### `packages/ai/src/index.ts`

- Added re-exports: `type DocumentContent`, `type DocumentMediaType`, `type ImageMediaType`, `type SupportedMediaType`.

### `packages/ai/test/extractors.registry.test.ts`

- `extractByType("malpractice_insurance", [])` → `extractByType("malpractice_insurance", [{ base64: "", mediaType: "image/jpeg" }])`.

  Justification: the "no extractor" path now throws before reaching the model, so the input shape just needs to typecheck.

### `apps/api/src/services/documentExtractionInline.ts` — the only live caller

- Added `MAX_BYTES = 20 * 1024 * 1024` (20 MB).
- Added `toSupportedMediaType(mime)` — explicit allow-list of `application/pdf`, `image/jpeg`, `image/png`, `image/gif`, `image/webp`. Any other MIME throws `"unsupported mime type for extraction: <mime>"`, which the existing catch logs and writes to the audit row's `reason`.
- Added `loadDocumentContent(fileUri, mimeType)`:
  1. Resolves the MIME type via the allow-list.
  2. Calls `getObjectStorage().getSignedUrl({ key, expiresInSeconds: 15*60 })`.
  3. `fetch()`s the bytes, rejects non-2xx responses.
  4. Caps total size at `MAX_BYTES` (the API's existing upload guard is 25 MB, but Anthropic's per-block limit is tighter — 20 MB gives us a clean failure mode before we hit the model).
  5. Returns `{ base64, mediaType }`.
- The lifecycle loop now reads `documents.mimeType` from the row, calls `loadDocumentContent()` once before the classify/extract pair, and passes the same `content` object to both:
  - `classifyDocument({ content, ... })` (was `{ imageUrl, ... }`)
  - `extractByType(documentType, [content], { ... })` (was `[signed.url]`)

### `apps/workers/src/activities/extraction.ts` — kept type-consistent

Workers are disabled in the staging compose, but they share the type surface. Updated to keep `pnpm typecheck` green:

- Same `MAX_BYTES`, `toSupportedMediaType`, `loadDocumentContent` helpers (inlined; no shared util because the workers package can't depend on api).
- `classifyActivity` and `extractActivity` now read `mimeType` alongside `fileUri` and pass inline `content` instead of signed URLs.
- The lifecycle stages and the `persistExtractionActivity` body are unchanged.

---

## 2. Failing → passing curl evidence

### 2.1 BEFORE — terminal `failed` (from §2 of `be-fixes-complete.md`)

Same upload chain (sign-upload → PUT → uploaded → poll):

```
=== before: pending
=== kick uploaded ===
+0s: running
+1s: failed
+4s: failed
+9s: failed
```

```
err: "400 Only HTTPS URLs are supported."
documentId: d337aba1-8f69-47ed-838d-8f6cf676b6c4
audit action: document.extraction_failed
```

### 2.2 AFTER — terminal `succeeded`

Sign in as Daniel + sign-upload a new JPEG slot:

```
$ curl -s -c /tmp/cred.cookies -H 'content-type: application/json' \
    -d '{"caseId":"22222222-cccc-4444-8888-000000000002"}' \
    http://localhost:3001/auth/dev/demo-provider-signin
{"ok":true,"redirectPath":"/case/22222222-cccc-4444-8888-000000000002"}

$ curl -s -b /tmp/cred.cookies -H 'content-type: application/json' \
    -d '{"documentType":"bls","mimeType":"image/jpeg","sizeBytes":13460,"originalFilename":"bls.jpg"}' \
    http://localhost:3001/v1/cases/22222222-cccc-4444-8888-000000000002/documents/sign-upload
{
  "documentId": "e86a83ba-528c-44ff-9452-a90e7c3f4b21",
  "uploadUrl":  "http://minio:9000/cred-dev/uploads/.../e86a83ba-...?X-Amz-...",
  ...
}
```

PUT a real JPEG (generated locally via PIL — 13.5 KB, text-rendered BLS card)
into the container so `minio:9000` resolves:

```
$ docker cp /tmp/bls.jpg cred-deploy-api-1:/tmp/bls.jpg
$ docker exec cred-deploy-api-1 sh -c "wget -q --method=PUT \
    --header='content-type: image/jpeg' --body-file=/tmp/bls.jpg -O- '$URL' && echo PUT_OK"
PUT_OK
```

Fire the `uploaded` route and poll:

```
$ curl -s -b /tmp/cred.cookies -X POST -H 'content-type: application/json' -d '{}' \
    http://localhost:3001/v1/cases/22222222-.../documents/e86a83ba-.../uploaded
{"id":"e86a83ba-...","extractionStatus":"processing", ...}

$ for i in 1 2 3 4 5 ...; do
    st=$(docker exec cred-deploy-postgres-1 psql -U cred -d cred -tAc \
        "SELECT extraction_status FROM documents WHERE id='e86a83ba-...';")
    echo "+${i}s: $st"
    [ "$st" = "succeeded" ] && break
    sleep 2
  done
+1s: succeeded
```

Terminal state in ~5 seconds (a single Anthropic round-trip), not failed.

---

## 3. psql evidence — populated `extracted_fields`

```
$ docker exec cred-deploy-postgres-1 psql -U cred -d cred -tAc \
    "SELECT extraction_status, jsonb_array_length(extracted_fields), classifier_confidence
     FROM documents WHERE id='e86a83ba-528c-44ff-9452-a90e7c3f4b21';"
succeeded|5|10000
```

(`classifier_confidence=10000` because the FE sent `documentType: "bls"` as a
hint, so we skip the classifier and treat it as 1.0 — same behaviour as
before the fix.)

The 5 extracted fields (all confidence 0.99) from the test JPEG:

| name                 | value           |
| -------------------- | --------------- |
| holder_name          | Daniel Cohen    |
| issuing_organization | AHA             |
| issue_date           | 2025-04-12      |
| expiration_date      | 2027-04-12      |
| card_number          | BLS-2026-78421  |

Re-extraction on the seeded medical_license PDF
(`33333333-dddd-4444-8888-000000000004`) — with a real (text-bearing) PDF
swapped in over the seed's 548-byte placeholder via
`mc cp local/cred-dev/seed/docs/daniel-license.pdf`:

```
$ docker exec cred-deploy-postgres-1 psql -U cred -d cred -tAc \
    "SELECT extraction_status, jsonb_array_length(extracted_fields), classifier_confidence
     FROM documents WHERE id='33333333-dddd-4444-8888-000000000004';"
succeeded|7|10000
```

7-field extraction from the real PDF:

| name            | value             |
| --------------- | ----------------- |
| license_number  | NY-887421         |
| state           | NY                |
| issue_date      | 2022-03-15        |
| expiration_date | 2027-03-15        |
| license_status  | Active            |
| licensee_name   | Daniel Cohen, MD  |
| specialty       | Cardiology        |

This proves the inline pipeline works for both PDFs (`{type:"document"}`
content block) and images (`{type:"image"}` content block).

For completeness, the same seeded row with the original 548-byte placeholder
PDF lands in `needs_review` with 7 null fields and `averageConfidence=0` —
Anthropic accepts the request (no 400) and returns null values for every
field because there's nothing on the page. This is the documented fall-back
behaviour, not a regression.

---

## 4. Audit log — `document.extracted`, zero failures

```
$ docker compose logs api | grep "document.extracted" | tail -3
api-1  | {"audit":true,"action":"document.extracted","targetEntityType":"document",
         "targetEntityId":"e86a83ba-528c-44ff-9452-a90e7c3f4b21",
         "workspaceId":"ce430dc5-3101-4716-b245-3c83d553c8da", ...}
api-1  | {"audit":true,"action":"document.extracted","targetEntityType":"document",
         "targetEntityId":"33333333-dddd-4444-8888-000000000004", ...}
api-1  | {"audit":true,"action":"document.extracted","targetEntityType":"document",
         "targetEntityId":"33333333-dddd-4444-8888-000000000004", ...}

$ docker compose logs api | grep -E "extraction_failed|Only HTTPS URLs"
(no output)
```

Plus the success-only stdout log line written by the inline service:

```
{"documentId":"e86a83ba-528c-44ff-9452-a90e7c3f4b21","status":"succeeded",
 "documentType":"bls","averageConfidence":0.99,
 "msg":"document_extraction_inline_complete"}
{"documentId":"33333333-dddd-4444-8888-000000000004","status":"succeeded",
 "documentType":"medical_license","averageConfidence":0.99,
 "msg":"document_extraction_inline_complete"}
```

The FE-shape `GET /v1/cases/.../documents/<id>` now returns
`extractionStatus: "ready"` (the FE's vocabulary for BE `succeeded`) with
populated `extractedFields` — the audit row of the FE follow-ups §7 in
`be-fixes-complete.md` ("Staging only — extraction terminates in failed")
is now obsolete and can be removed.

---

## 5. Discoveries

1. **Classify-then-extract sequencing.** The pre-fix lifecycle called
   `getSignedUrl` twice — once before classify and once before extract —
   and rebuilt the signed URL inside `extractActivity`. After the fix, the
   inline service downloads the bytes **once** (before classify) and reuses
   the same `DocumentContent` for both calls. This is a free latency win
   (one MinIO fetch per document instead of two) and a free cost win (no
   doubled signed-URL machinery for what is the same byte stream).

2. **MIME type mapping decisions.** The codebase already enforces a content
   type allow-list at the `sign-upload` boundary (cases.ts limits to
   `image/jpeg`, `image/png`, `application/pdf` — see audit §6.4). The new
   `toSupportedMediaType()` in `documentExtractionInline.ts` is the
   downstream defence-in-depth: it covers the four image MIME types
   Anthropic accepts (`jpeg | png | gif | webp`) plus `application/pdf`,
   throwing a readable error for anything else. Documents with NULL
   `mime_type` (legacy rows) also raise the same error — `mimeType` is
   nullable in the schema but always populated for any row created via the
   new sign-upload route. The 20 MB cap is enforced in the loader so a
   pathological row doesn't waste an Anthropic round-trip.

3. **Anthropic SDK content block types.** The pre-fix path was passing
   `{type:"image", source:{type:"url",url}}` for every document type,
   including PDFs. That is double-wrong: Anthropic rejects non-HTTPS URLs
   on the URL path, **and** it would not have interpreted a PDF as an
   image block anyway. The new `contentBlock()` helper switches on the
   media type to emit either `{type:"document"}` (PDF) or `{type:"image"}`
   (raster), matching the `parseFacilityPacket` precedent exactly.

4. **MinIO bucket access from the api container.** No issues encountered.
   The `getObjectStorage()` adapter is already configured to talk to the
   internal `minio:9000` hostname, and the api container has been doing
   exactly that for the facility-ingest path for weeks. Once the inline
   service stopped handing the signed URL to Anthropic and started
   fetching it itself, everything else fell into place.

5. **Temporal workers stay disabled.** The `apps/workers` extraction
   activities were updated to compile against the new `extractByType`
   signature, but the worker container itself is still off in the staging
   compose. No worker rebuild was required. When Temporal comes back
   online, the worker path will be on the same inline-base64 transport.

6. **Existing unit tests.** Only one assertion needed an update — the
   `extractByType("malpractice_insurance", [])` smoke test in
   `packages/ai/test/extractors.registry.test.ts`. The "no extractor for
   this type" branch is checked before the content shape matters, so the
   fix is a one-line input rewrite.

---

## 6. Validation matrix

| Doc type      | Source     | MIME            | Status      | Fields | Notes                                          |
| ------------- | ---------- | --------------- | ----------- | ------ | ---------------------------------------------- |
| bls           | new upload | image/jpeg      | succeeded   | 5      | All 5 expected fields populated, conf 0.99     |
| medical_license | re-extract | application/pdf | succeeded   | 7      | Real text-bearing PDF, all 7 fields populated  |
| medical_license | re-extract | application/pdf | needs_review | 7     | 548-byte placeholder PDF — 7 null fields, conf 0 (expected — Anthropic accepts but has nothing to extract) |

Zero `document.extraction_failed` audit rows since the fix landed; zero
`400 Only HTTPS URLs are supported` errors in the api log.

---

## TLDR

The inline extraction lifecycle now downloads the uploaded bytes from
MinIO and hands them to Anthropic as inline base64 — `{type:"document"}`
for PDFs, `{type:"image"}` for images. The `extractByType` and
`classifyDocument` surfaces both took breaking signature changes
(`imageUrls: string[]` / `imageUrl: string` → `contents: DocumentContent[]`
/ `content: DocumentContent`), and all eight per-type extractors plus the
workers' Temporal activities were migrated atomically — no overloads were
needed because `documentExtractionInline.ts` was the only live caller in
the staging stack. The state machine terminates at `succeeded` (or
`needs_review` for low-confidence content) with non-empty
`extracted_fields` and a `document.extracted` audit row, exactly per spec.
