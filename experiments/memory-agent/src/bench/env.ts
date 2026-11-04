import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, FileError, LineScanner, ok, type BinaryReader, type ExecutionEnv, type FileInfo, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import type { Backend } from "./backend.js";

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

const notFound = <T>(path: string): Result<T, FileError> => err(new FileError("not_found", `${path} not found`, path));

export class ShellEnv {
  readonly id: string;
  cwd: string;

  constructor(
    private readonly backend: Backend,
    cwd: string,
  ) {
    this.id = `${backend.name}:${backend.id}`;
    this.cwd = cwd;
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return ok(path.startsWith("/") ? posix.normalize(path) : posix.join(this.cwd, path));
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.absolutePath(path, context);
  }

  async exists(path: string, _context: Context): Promise<Result<boolean, FileError>> {
    const result = await this.backend.exec(`test -e ${quote(path)}`);
    return ok(result.exitCode === 0);
  }

  async fileInfo(path: string, _context: Context): Promise<Result<FileInfo, FileError>> {
    const result = await this.backend.exec(`if [ -d ${quote(path)} ]; then echo d; elif [ -f ${quote(path)} ]; then wc -c < ${quote(path)}; else exit 1; fi`);
    if (result.exitCode !== 0) return notFound(path);
    const text = result.stdout.trim();
    return ok({ name: posix.basename(path), path, kind: text === "d" ? "directory" : "file", size: text === "d" ? 0 : Number(text), mtimeMs: 0 });
  }

  async readTextFile(path: string, _context: Context): Promise<Result<string, FileError>> {
    const result = await this.backend.exec(`cat ${quote(path)}`);
    return result.exitCode === 0 ? ok(result.stdout) : notFound(path);
  }

  async openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, _context: Context): Promise<Result<BinaryReader, FileError>> {
    const result = await this.backend.exec(`base64 < ${quote(path)} | tr -d '\\n'`);
    if (result.exitCode !== 0) return notFound(path);
    const bytes = new Uint8Array(Buffer.from(result.stdout.trim(), "base64"));
    const info: FileInfo = { name: posix.basename(path), path, kind: "file", size: bytes.length, mtimeMs: 0 };
    return ok({
      info: async () => ok(info),
      read: async (offset, length) => ok(bytes.slice(offset, offset + length)),
      scanLines: async (options) => {
        const scanner = new LineScanner(options.startLine, options.endLine);
        scanner.push(bytes);
        return ok(scanner.finish());
      },
      close: async () => undefined,
    });
  }

  async writeFile(path: string, content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
    const encoded = Buffer.from(content).toString("base64");
    const result = await this.backend.exec(`mkdir -p ${quote(posix.dirname(path))} && echo ${quote(encoded)} | base64 -d > ${quote(path)}`);
    return result.exitCode === 0 ? ok(undefined) : err(new FileError("unknown", result.stderr, path));
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context) {
    const line = typeof command === "string" ? command : command.map(quote).join(" ");
    const result = await this.backend.exec(`cd ${quote(options?.cwd ?? this.cwd)} && ${line}`);
    if (result.stdout !== "") options?.onOutput?.(result.stdout, context, { stream: "stdout" });
    if (result.stderr !== "") options?.onOutput?.(result.stderr, context, { stream: "stderr" });
    return ok<ShellExecResult, never>({ exitCode: result.exitCode });
  }

  async cleanup(_context: Context): Promise<void> {}
}

export const asEnv = (env: ShellEnv): ExecutionEnv => env as unknown as ExecutionEnv;
