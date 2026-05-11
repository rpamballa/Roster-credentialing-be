export interface PutSignedUrl {
  url: string;
  method: "PUT";
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
