import { GCSAdapter } from "./adapters/gcs.js";
import type { ObjectStorage } from "./types.js";

let cached: ObjectStorage | undefined;

export function getObjectStorage(): ObjectStorage {
  if (!cached) cached = new GCSAdapter();
  return cached;
}

/** Test-only: force the next getObjectStorage() to build a fresh adapter. */
export function resetObjectStorageForTesting(): void {
  cached = undefined;
}
