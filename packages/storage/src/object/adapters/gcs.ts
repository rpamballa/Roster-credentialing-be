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
  private readonly emulatorPublicUrl: string | undefined;

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
    // Emulator URLs the browser will hit — same host as apiEndpoint by
    // default; caller can override for docker → host networking.
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
      // fake-gcs-server accepts any URL that matches its bucket/object
      // layout; skip real v4 signing.
      return {
        url: this.directEmulatorUrl(params.key),
        method: "PUT",
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
    const [exists] = await this.storage.bucket(this.bucketName).file(key).exists();
    return exists;
  }

  async delete(key: string): Promise<void> {
    await this.storage.bucket(this.bucketName).file(key).delete({ ignoreNotFound: true });
  }

  private directEmulatorUrl(key: string): string {
    const host = this.emulatorPublicUrl?.replace(/\/+$/, "");
    return `${host}/storage/v1/b/${this.bucketName}/o/${encodeURIComponent(key)}`;
  }
}
