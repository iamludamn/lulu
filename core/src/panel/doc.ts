import { defineDoc } from "@earendil-works/pi-durable";
import type { PanelState } from "../protocol/panel.js";
import { STORED_DOC_KINDS } from "../durable-names.js";

export const PanelDoc = defineDoc<PanelState>({
  kind: STORED_DOC_KINDS.panel,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ order: [], widgets: {} }),
});
