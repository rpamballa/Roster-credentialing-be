// Cloud-neutral object storage facade over Google Cloud Storage.
// Prod uses the real GCS API; local dev uses fake-gcs-server (routed via
// STORAGE_EMULATOR_HOST). To swap in another provider, add a sibling
// adapter in ./adapters/ that satisfies ObjectStorage and rewire factory.ts.
export type { ObjectStorage, PutSignedUrl, GetSignedUrl } from "./types.js";
export { getObjectStorage, resetObjectStorageForTesting } from "./factory.js";
