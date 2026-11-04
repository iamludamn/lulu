import { defineExtension, section } from "@earendil-works/pi-durable";
import { RecallDoc } from "./doc.js";
import type { ReadableFiles } from "./files.js";
import { createReadTools } from "./tools.js";

export function createMemoryExtension(context: () => Promise<string>, files: ReadableFiles) {
  return defineExtension({
    name: "pistack.memory",
    tools: createReadTools(files),
    sections: [
      section(
        "memory",
        async (input, scope) => {
          const shown = input.shown.memory;
          if ((await input.read.snapshot(RecallDoc, scope))?.inject !== true) return shown;
          return (await context()) || shown;
        },
        { tag: false },
      ),
    ],
  });
}
