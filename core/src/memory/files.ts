export interface MemoryCommit {
  readonly oid: string;
  readonly message: string;
  readonly at: number;
}

export interface MemoryFiles {
  files(): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  changed(): Promise<string[]>;
  discard(path: string): Promise<void>;
  commit(message: string): Promise<string | undefined>;
  commits(depth: number): Promise<MemoryCommit[]>;
}

export type ReadableFiles = Pick<MemoryFiles, "files" | "read">;
