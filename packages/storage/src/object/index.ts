// Cloud-neutral object storage facade. The concrete adapter is selected at
// import-time based on environment. Add GCS / Azure adapters by writing a
// sibling file that satisfies the same interface and switching here.
export type { ObjectStorage, PutSignedUrl, GetSignedUrl } from "./types.js";
export { getObjectStorage } from "./factory.js";
