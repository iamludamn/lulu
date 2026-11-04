import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import type { Bash, IFileSystem } from "just-bash";
import { getContext } from "./context.js";

const OUTPUT_LIMIT = 4000;
const COMMAND_TIMEOUT_MS = 10000;

export type MemoryView = { fs: IFileSystem; bash: Bash; prompt: string };

const clip = (text: string): string => (text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n...[truncated ${text.length - OUTPUT_LIMIT} chars]` : text);

export function createMemoryAgentExtension(view: () => MemoryView) {
  const bash = defineTool({
    name: "bash",
    description: "在记忆仓库中执行 bash 命令（cat / grep / ls / find / sed 等）。",
    parameters: Type.Object({ command: Type.String() }),
    replay: "unsafe",
    execute: async ({ command }) => {
      const result = await view().bash.exec(command, { signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) });
      const text = clip(`${result.stdout}${result.stderr === "" ? "" : `\n[stderr]\n${result.stderr}`}\n[exit ${result.exitCode}]`);
      return { output: [{ type: "text", text }], isError: result.exitCode !== 0 };
    },
  });
  return defineExtension({
    name: "pistack.memory-agent",
    tools: [bash],
    sections: [section("rules", () => view().prompt, { tag: false }), section("memory", () => getContext(view().fs), { tag: false })],
  });
}
