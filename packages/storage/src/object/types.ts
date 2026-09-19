export interface PutSignedUrl {
  url: string;
  /**
   * Real-GCS signed URLs are always PUT (v4-signed XML API).
   * The fake-gcs-server emulator uses POST to its
   * `/upload/storage/v1/b/<bucket>/o?uploadType=media` endpoint;
   * that path exists in the emulator branch of the adapter only.
   */
  method: "PUT" | "POST";
  headers: Record<string, string>;
  key: string;
  expiresAt: Date;
}

export interface GetSignedUrl {
  url: string;
  expiresAt: Date;
}

export interface ObjectStorage {
  putSignedUrl(params: {
    key: string;
    contentType: string;
    expiresInSeconds?: number;
  }): Promise<PutSignedUrl>;
  getSignedUrl(params: { key: string; expiresInSeconds?: number }): Promise<GetSignedUrl>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}
