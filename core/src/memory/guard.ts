import type { MemoryFiles } from "./files.js";

const SENSITIVE: readonly RegExp[] = [
  /(?:password|passwd|passphrase|secret|token|api[ _-]?key|密码|口令|密钥)\s*(?:[:=：]|是|为|is\b)/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

export const isSensitive = (text: string): boolean => SENSITIVE.some((pattern) => pattern.test(text));

export async function guardChanges(files: MemoryFiles): Promise<{ blocked: string[] }> {
  const blocked: string[] = [];
  for (const path of await files.changed()) {
    if (isSensitive((await files.read(path)) ?? "")) {
      await files.discard(path);
      blocked.push(path);
    }
  }
  return { blocked };
}
