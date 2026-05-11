import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@cred/config";
import type { GetSignedUrl, ObjectStorage, PutSignedUrl } from "../types.js";

const DEFAULT_TTL = 15 * 60;

export class S3Adapter implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const cfg = env();
    const opts: S3ClientConfig = {
      region: cfg.S3_REGION,
      forcePathStyle: !!cfg.S3_ENDPOINT,
    };
    if (cfg.S3_ENDPOINT) opts.endpoint = cfg.S3_ENDPOINT;
    if (cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY) {
      opts.credentials = {
        accessKeyId: cfg.S3_ACCESS_KEY_ID,
        secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
      };
    }
    this.client = new S3Client(opts);
    this.bucket = cfg.S3_BUCKET;
  }

  async putSignedUrl(params: {
    key: string;
    contentType: string;
    expiresInSeconds?: number;
  }): Promise<PutSignedUrl> {
    const expiresIn = params.expiresInSeconds ?? DEFAULT_TTL;
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      ContentType: params.contentType,
    });
    const url = await awsGetSignedUrl(this.client, cmd, { expiresIn });
    return {
      url,
      method: "PUT",
      headers: { "content-type": params.contentType },
      key: params.key,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async getSignedUrl(params: { key: string; expiresInSeconds?: number }): Promise<GetSignedUrl> {
    const expiresIn = params.expiresInSeconds ?? DEFAULT_TTL;
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: params.key });
    const url = await awsGetSignedUrl(this.client, cmd, { expiresIn });
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const e = err as { $metadata?: { httpStatusCode?: number } };
      if (e?.$metadata?.httpStatusCode === 404) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
