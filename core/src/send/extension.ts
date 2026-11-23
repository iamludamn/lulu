import { defineExtension } from "@earendil-works/pi-durable";
import { type ArtifactCheck, createSendTool } from "./tool.js";
import { STORED_EXTENSION_NAMES } from "../durable-names.js";

export const createSendExtension = (exists: ArtifactCheck | undefined, monitorConfigured = false) =>
  defineExtension({
    name: STORED_EXTENSION_NAMES.send,
    tools: [createSendTool(exists, monitorConfigured)],
  });
