import { S3Adapter } from "./adapters/s3.js";
import type { ObjectStorage } from "./types.js";

let cached: ObjectStorage | undefined;

export function getObjectStorage(): ObjectStorage {
  if (!cached) cached = new S3Adapter();
  return cached;
}
