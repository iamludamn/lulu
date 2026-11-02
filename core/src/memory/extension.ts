import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ReadableFiles } from "./files.js";
import { createReadTools } from "./tools.js";

export function createMemoryExtension(context: () => Promise<string>, files: ReadableFiles) {
  return defineExtension({
    name: "pistack.memory",
    tools: createReadTools(files),
    sections: [section("memory", async () => (await context()) || undefined, { tag: false })],
  });
}
