import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  FileError,
  LineScanner,
  err,
  ok,
  toError,
  type BinaryReader,
  type ExecutionEnv,
  type FileInfo,
  type LineScan,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { CommandExitError, FileType, NotFoundError, TimeoutError, type EntryInfo, type Sandbox } from "e2b";

export const SANDBOX_IDLE_MS = 120_000;
const UNBOUNDED_COMMAND_MS = 3_600_000;

const unsupported =<T>(operation: string): Result<T, FileError> =>
  err(new FileError("not_supported", `${operation} is not supported in a sandbox`));

const fileError = (error: unknown, path: string): FileError => {
  if (error instanceof FileError) return error;
  const cause = toError(error);
  return new FileError(error instanceof NotFoundError ? "not_found" : "unknown", cause.message, path, cause);
};

async function attempt<T>(path: string, run: () => Promise<T>): Promise<Result<T, FileError>> {
  try {
    return ok(await run());
  } catch (error) {
    return err(fileError(error, path));
  }
}

function resolvePath(cwd: string, path: string): string {
  const expanded = path === "~" ? cwd : path.startsWith("~/") ? `${cwd}${path.slice(1)}` : path;
  const parts: string[] = [];
  for (const part of (expanded.startsWith("/") ? expanded : `${cwd}/${expanded}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

const infoOf = (entry: EntryInfo): FileInfo => ({
  name: entry.name,
  path: entry.path,
  kind: entry.type === FileType.DIR ? "directory" : entry.symlinkTarget !== undefined ? "symlink" : "file",
  size: entry.size,
  mtimeMs: entry.modifiedTime?.getTime() ?? 0,
});

class SandboxBinaryReader implements BinaryReader {
  readonly #file: FileInfo;
  readonly #load: () => Promise<Uint8Array>;
  #bytes: Promise<Uint8Array> | undefined;

  constructor(file: FileInfo, load: () => Promise<Uint8Array>) {
    this.#file = file;
    this.#load = load;
  }

  async info(): Promise<Result<FileInfo, FileError>> {
    return ok(this.#file);
  }

  read(offset: number, length: number): Promise<Result<Uint8Array, FileError>> {
    return attempt(this.#file.path, async () => (await (this.#bytes ??= this.#load())).subarray(offset, offset + length));
  }

  scanLines(options: { startLine: number; endLine?: number }): Promise<Result<LineScan, FileError>> {
    return attempt(this.#file.path, async () => {
      const scanner = new LineScanner(options.startLine, options.endLine);
      scanner.push(await (this.#bytes ??= this.#load()));
      return scanner.finish();
    });
  }

  async close(): Promise<void> {}
}

export class SandboxExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly #sandbox: Sandbox;

  constructor(sandbox: Sandbox, cwd: string) {
    this.id = `e2b:${sandbox.sandboxId}`;
    this.cwd = cwd;
    this.#sandbox = sandbox;
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(resolvePath(this.cwd, path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(parts.join("/").replace(/\/+/g, "/"));
  }

  readTextFile(path: string): Promise<Result<string, FileError>> {
    return attempt(path, () => this.#sandbox.files.read(resolvePath(this.cwd, path), { format: "text" }));
  }

  readBinaryFile(path: string): Promise<Result<Uint8Array, FileError>> {
    return attempt(path, () => this.#sandbox.files.read(resolvePath(this.cwd, path), { format: "bytes" }));
  }

  openBinaryReader(path: string): Promise<Result<BinaryReader, FileError>> {
    const absolute = resolvePath(this.cwd, path);
    return attempt(path, async () => {
      const entry = await this.#sandbox.files.getInfo(absolute);
      if (entry.type === FileType.DIR) throw new FileError("is_directory", `${path} is a directory`, path);
      return new SandboxBinaryReader(infoOf(entry), () => this.#sandbox.files.read(absolute, { format: "bytes" }));
    });
  }

  writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    return attempt(path, async () => {
      await this.#sandbox.files.write(resolvePath(this.cwd, path), typeof content === "string" ? content : new Blob([new Uint8Array(content)]));
    });
  }

  renameFile(sourcePath: string, destinationPath: string): Promise<Result<void, FileError>> {
    return attempt(sourcePath, async () => {
      await this.#sandbox.files.rename(resolvePath(this.cwd, sourcePath), resolvePath(this.cwd, destinationPath));
    });
  }

  fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    return attempt(path, async () => infoOf(await this.#sandbox.files.getInfo(resolvePath(this.cwd, path))));
  }

  listDir(path: string): Promise<Result<FileInfo[], FileError>> {
    return attempt(path, async () => (await this.#sandbox.files.list(resolvePath(this.cwd, path))).map(infoOf));
  }

  canonicalPath(path: string): Promise<Result<string, FileError>> {
    const absolute = resolvePath(this.cwd, path);
    return attempt(path, async () => (await this.#sandbox.commands.run(`realpath -m -- ${quote(absolute)}`)).stdout.trim());
  }

  exists(path: string): Promise<Result<boolean, FileError>> {
    return attempt(path, () => this.#sandbox.files.exists(resolvePath(this.cwd, path)));
  }

  createDir(path: string): Promise<Result<void, FileError>> {
    return attempt(path, async () => {
      await this.#sandbox.files.makeDir(resolvePath(this.cwd, path));
    });
  }

  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
    return attempt(path, async () => {
      try {
        await this.#sandbox.files.remove(resolvePath(this.cwd, path));
      } catch (error) {
        if (!(options?.force === true && error instanceof NotFoundError)) throw error;
      }
    });
  }

  createTempDir(prefix?: string): Promise<Result<string, FileError>> {
    return attempt("tmp", async () => (await this.#sandbox.commands.run(`mktemp -d ${quote(`/tmp/${prefix ?? "tmp-"}XXXXXX`)}`)).stdout.trim());
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const signal = context.abortSignal;
    if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    const line = typeof command === "string" ? command : command.map(quote).join(" ");
    if (line === "") return err(new ExecutionError("spawn_error", "Empty command"));
    const emit = (stream: "stdout" | "stderr") => (text: string): void => options?.onOutput?.(text, context, { stream });
    let handle;
    try {
      await this.#sandbox.setTimeout(options?.timeout === undefined ? UNBOUNDED_COMMAND_MS : options.timeout * 1000 + SANDBOX_IDLE_MS);
      handle = await this.#sandbox.commands.run(line, {
        background: true,
        cwd: options?.cwd === undefined ? this.cwd : resolvePath(this.cwd, options.cwd),
        ...(options?.env === undefined ? {} : { envs: options.env }),
        timeoutMs: options?.timeout === undefined ? 0 : options.timeout * 1000,
        onStdout: emit("stdout"),
        onStderr: emit("stderr"),
      });
    } catch (error) {
      return err(new ExecutionError("spawn_error", toError(error).message, toError(error)));
    }
    const running = handle;
    const stop = (): void => void running.kill();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const result = await running.wait();
      return ok({ exitCode: result.exitCode });
    } catch (error) {
      if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
      if (error instanceof CommandExitError) return ok({ exitCode: error.exitCode });
      stop();
      if (error instanceof TimeoutError) return err(new ExecutionError("timeout", toError(error).message, toError(error)));
      return err(new ExecutionError("unknown", toError(error).message, toError(error)));
    } finally {
      signal?.removeEventListener("abort", stop);
      await this.#sandbox.setTimeout(SANDBOX_IDLE_MS).catch(() => undefined);
    }
  }

  async openTextLineReader(): Promise<Result<never, FileError>> {
    return unsupported("openTextLineReader");
  }

  async readTextLines(): Promise<Result<string[], FileError>> {
    return unsupported("readTextLines");
  }

  async appendFile(): Promise<Result<void, FileError>> {
    return unsupported("appendFile");
  }

  async truncateFile(): Promise<Result<void, FileError>> {
    return unsupported("truncateFile");
  }

  async flushFile(): Promise<Result<void, FileError>> {
    return unsupported("flushFile");
  }

  async openDirReader(): Promise<Result<never, FileError>> {
    return unsupported("openDirReader");
  }

  async watch(): Promise<Result<never, FileError>> {
    return unsupported("watch");
  }

  async createTempFile(): Promise<Result<string, FileError>> {
    return unsupported("createTempFile");
  }

  async cleanup(): Promise<void> {}
}
