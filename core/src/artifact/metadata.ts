export interface ArtifactVersion {
  version: number;
  key: string;
  size: number;
  contentType: string;
}

export interface ArtifactUpload extends ArtifactVersion {
  uploadId: string;
  name: string;
  committed: boolean;
  staged: string | null;
  baseVersion: number | null;
}

export interface UploadReservation {
  name: string;
  size: number;
  contentType: string;
  requestId?: string;
  baseVersion?: number;
  staged: boolean;
  quota: number;
}

export type DiscardedArtifact = { key: string; token: string };

export interface ArtifactMetadataStore {
  list(prefix: string, limit: number): Promise<(ArtifactVersion & { name: string })[]>;
  versions(name: string): Promise<{ latest: number; entries: ArtifactVersion[] } | undefined>;
  version(name: string, version?: number): Promise<ArtifactVersion | undefined>;
  request(id: string): Promise<ArtifactUpload | undefined>;
  upload(id: string): Promise<ArtifactUpload | undefined>;
  reserve(reservation: UploadReservation): Promise<ArtifactUpload>;
  commit(upload: ArtifactUpload, size: number, quota: number): Promise<ArtifactVersion | undefined>;
  delete(name: string): Promise<boolean>;
  discarded(limit: number): Promise<DiscardedArtifact[]>;
  forgetDiscarded(entries: DiscardedArtifact[]): Promise<void>;
}
