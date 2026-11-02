import { defineExtension, section } from "@earendil-works/pi-durable";
import { PanelDoc } from "./doc.js";
import { PanelTool } from "./tool.js";

const PanelSection = section("panel", async (input, context) => {
  const state = await input.read.snapshot(PanelDoc, context);
  const rows = (state?.order ?? []).flatMap((id) => {
    const widget = state?.widgets[id];
    return widget ? ["- " + id + ": " + widget.title + " (" + widget.body.kind + ", updated " + new Date(widget.updatedAt).toISOString().slice(0, 16) + "Z)"] : [];
  });
  return rows.length === 0 ? undefined : rows.join("\n");
});

export const PanelExtension = defineExtension({
  name: "pistack.panel",
  tools: [PanelTool],
  sections: [PanelSection],
});
