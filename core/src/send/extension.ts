import { defineExtension } from "@earendil-works/pi-durable";
import { type ArtifactCheck, createSendTool } from "./tool.js";

export const createSendExtension = (exists: ArtifactCheck | undefined) =>
  defineExtension({
    name: "pistack.send",
    tools: [createSendTool(exists)],
  });
