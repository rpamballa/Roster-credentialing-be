import { env } from "@cred/config";
import { Storage } from "@google-cloud/storage";
import type { GetSignedUrl, ObjectStorage, PutSignedUrl } from "../types.js";

const DEFAULT_TTL = 15 * 60;

/**
 * Google Cloud Storage adapter.
 *
 * Auth model:
 *   - Prod: Application Default Credentials from the attached Compute Engine
 *     service account. Signed-URL generation calls the IAM `signBlob` API,
 *     so the SA must have `roles/iam.serviceAccountTokenCreator` on itself.
 *   - Local dev: the `fake-gcs-server` emulator; when `STORAGE_EMULATOR_HOST`
 *     is set, the SDK routes every call there and no real credentials are
 *     needed. Signed URLs are direct URLs into the emulator (it does not
 *     verify signatures).
 */
export class GCSAdapter implements ObjectStorage {
  private readonly storage: Storage;
  private readonly bucketName: string;
  /** Emulator URL the browser dials (usually `http://localhost:4443`). */
  private readonly emulatorPublicUrl: string | undefined;
  /**
   * Emulator URL the API container dials (usually `http://gcs-emulator:4443`
   * on the internal docker network). When the API and the emulator are on
   * the same machine outside docker, this equals `emulatorPublicUrl`.
   */
  private readonly emulatorInternalUrl: string | undefined;

  constructor() {
    const cfg = env();
    // Setting apiEndpoint tells the SDK to talk to the emulator. The
    // corresponding STORAGE_EMULATOR_HOST env var is also picked up by
    // helpers inside @google-cloud/storage, so we set both.
    const emulator = cfg.STORAGE_EMULATOR_HOST;
    if (emulator) {
      process.env.STORAGE_EMULATOR_HOST = emulator;
    }
    this.storage = new Storage({
      ...(cfg.GCP_PROJECT_ID ? { projectId: cfg.GCP_PROJECT_ID } : {}),
      ...(emulator ? { apiEndpoint: emulator } : {}),
    });
    this.bucketName = cfg.GCS_BUCKET;
    // Two emulator URLs — one for browsers (baked into signed URLs) and
    // one for server-side calls the API makes to verify uploads.
    this.emulatorInternalUrl = emulator;
    this.emulatorPublicUrl = cfg.STORAGE_EMULATOR_PUBLIC_URL ?? emulator;
  }

  async putSignedUrl(params: {
    key: string;
    contentType: string;
    expiresInSeconds?: number;
  }): Promise<PutSignedUrl> {
    const expiresIn = params.expiresInSeconds ?? DEFAULT_TTL;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const file = this.storage.bucket(this.bucketName).file(params.key);

    if (this.emulatorPublicUrl) {
      // fake-gcs-server does NOT accept a raw PUT against the object
      // resource path (`/storage/v1/b/<bucket>/o/<key>`) — that path
      // is the JSON-API "update object metadata" endpoint and returns
      // "invalid uploadType" / "metadata couldn't decode" on binary
      // bodies. The direct-upload endpoint is a POST to
      //   /upload/storage/v1/b/<bucket>/o?uploadType=media&name=<key>
      // with the raw bytes as the body. Real prod GCS uses a v4-signed
      // XML-style PUT and works fine — this branch only fires when
      // STORAGE_EMULATOR_HOST is set.
      return {
        url: this.emulatorUploadUrl(params.key),
        method: "POST",
        headers: { "content-type": params.contentType },
        key: params.key,
        expiresAt,
      };
    }

    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType: params.contentType,
    });
    return {
      url,
      method: "PUT",
      headers: { "content-type": params.contentType },
      key: params.key,
      expiresAt,
    };
  }

  async getSignedUrl(params: {
    key: string;
    expiresInSeconds?: number;
  }): Promise<GetSignedUrl> {
    const expiresIn = params.expiresInSeconds ?? DEFAULT_TTL;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    if (this.emulatorPublicUrl) {
      return { url: this.directEmulatorUrl(params.key), expiresAt };
    }
    const [url] = await this.storage
      .bucket(this.bucketName)
      .file(params.key)
      .getSignedUrl({ version: "v4", action: "read", expires: expiresAt });
    return { url, expiresAt };
  }

  async exists(key: string): Promise<boolean> {
    // In prod the SDK's exists() is authoritative — it authenticates
    // via ADC and hits real GCS. In emulator mode the SDK's
    // `.file(key).exists()` returns false even when the object is
    // there (a well-known fake-gcs-server ↔ SDK auth compatibility
    // gap: the SDK's metadata request needs credentials the emulator
    // doesn't handle, so it silently treats the 401 as "not found").
    // Bypass with a raw HEAD to the internal emulator URL (the API
    // container uses the docker-network hostname, not the browser-
    // facing one). That's how upload-finalize verifies the bytes
    // actually landed before flipping the document to `uploaded`.
    if (this.emulatorInternalUrl) {
      const host = this.emulatorInternalUrl.replace(/\/+$/, "");
      const url = `${host}/storage/v1/b/${this.bucketName}/o/${encodeURIComponent(key)}`;
      const res = await fetch(url, { method: "HEAD" });
      return res.status === 200;
    }
    const [exists] = await this.storage.bucket(this.bucketName).file(key).exists();
    return exists;
  }

  async delete(key: string): Promise<void> {
    await this.storage.bucket(this.bucketName).file(key).delete({ ignoreNotFound: true });
  }

  /** GET metadata / download URL — used by `getSignedUrl` (readback). */
  private directEmulatorUrl(key: string): string {
    const host = this.emulatorPublicUrl?.replace(/\/+$/, "");
    return `${host}/storage/v1/b/${this.bucketName}/o/${encodeURIComponent(key)}`;
  }

  /**
   * Direct-upload endpoint for `fake-gcs-server`. Distinct from the object
   * resource path above — this one accepts the raw bytes as the request
   * body via `uploadType=media`. See the comment in `putSignedUrl` for
   * why this exists.
   */
  private emulatorUploadUrl(key: string): string {
    const host = this.emulatorPublicUrl?.replace(/\/+$/, "");
    return `${host}/upload/storage/v1/b/${this.bucketName}/o?uploadType=media&name=${encodeURIComponent(key)}`;
  }
}
