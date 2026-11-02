import { defineExtension, section } from "@earendil-works/pi-durable";
import { AssetsDoc } from "./doc.js";
import { type ArtifactCheck, createSendTool } from "./tool.js";

const ASSET_ROWS = 20;

const AssetsSection = section("assets", async (input, context) => {
  const state = await input.read.snapshot(AssetsDoc, context);
  const rows = (state?.items ?? []).slice(0, ASSET_ROWS).map((item) => `- ${item.ref} · ${item.title} · kept ${new Date(item.savedAt).toISOString().slice(5, 10)}`);
  return rows.length === 0 ? undefined : rows.join("\n");
});

export const createSendExtension = (exists: ArtifactCheck | undefined) =>
  defineExtension({
    name: "pistack.send",
    tools: [createSendTool(exists)],
    sections: [AssetsSection],
  });
