import type { MemoryResource } from "./doc.js";

export interface MemoryCommit {
  readonly oid: string;
  readonly message: string;
  readonly at: number;
}

export type PublishedMemory = { version: string; files: Record<string, string> };
export type PublishedCatalog = { resources: MemoryResource[]; cacheHit: boolean; fileReads: number; sqlRowsRead: number };

export interface MemoryFiles {
  published(): Promise<PublishedMemory>;
  publishedCatalog(): Promise<PublishedCatalog>;
  readVersion(path: string, version: string): Promise<string | undefined>;
  files(): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  changed(): Promise<string[]>;
  discard(path: string): Promise<void>;
  commit(message: string): Promise<string | undefined>;
  commits(depth: number): Promise<MemoryCommit[]>;
}

export type ReadableFiles = { files(): Promise<string[]>; read(path: string, version?: string): Promise<string | undefined> };
