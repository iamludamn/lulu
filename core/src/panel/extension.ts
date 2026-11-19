import { defineExtension, section } from "@earendil-works/pi-durable";
import { PanelDoc } from "./doc.js";
import { createPanelTool } from "./tool.js";
import { STORED_EXTENSION_NAMES } from "../durable-names.js";

const PanelSection = section("panel", async (input, context) => {
  const state = await input.read.snapshot(PanelDoc, context);
  const rows = (state?.order ?? []).flatMap((id) => {
    const widget = state?.widgets[id];
    return widget && !["space", "web"].includes(widget.body.kind) ? ["- " + id + ": " + widget.title + " (" + widget.body.kind + ", updated " + new Date(widget.updatedAt).toISOString().slice(0, 16) + "Z)"] : [];
  });
  return rows.length === 0 ? undefined : rows.join("\n");
});

export const createPanelExtension = () =>
  defineExtension({
    name: STORED_EXTENSION_NAMES.panel,
    tools: [createPanelTool()],
    sections: [PanelSection],
  });
