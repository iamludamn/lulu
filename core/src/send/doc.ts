import { defineDoc } from "@earendil-works/pi-durable";
import type { AssetItem } from "../protocol/send.js";
import { STORED_DOC_KINDS } from "../durable-names.js";

export const AssetsDoc = defineDoc<{ items: AssetItem[] }>({
  kind: STORED_DOC_KINDS.assets,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ items: [] }),
});

export type Nudge = { message: number; requestId: string; id: number | null };

export const DeliveryDoc = defineDoc<{ since: number | null; nudges: Nudge[] }>({
  kind: STORED_DOC_KINDS.delivery,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ since: null, nudges: [] }),
});

export type Make = { origin: string; requestId: string; id: number | null; at: number };

export const MakeDoc = defineDoc<{ makes: Make[] }>({
  kind: STORED_DOC_KINDS.make,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ makes: [] }),
});
