import { defineDoc } from "@earendil-works/pi-durable";
import type { PanelState } from "../protocol/panel.js";

export const PanelDoc = defineDoc<PanelState>({
  kind: "pistack.panel",
  version: 1,
  scope: "session",
  initial: () => ({ order: [], widgets: {} }),
});
