import { defineDoc } from "@earendil-works/pi-durable";
import type { AssetItem } from "../protocol/send.js";

export const AssetsDoc = defineDoc<{ items: AssetItem[] }>({
  kind: "pistack.assets",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
});

export type Nudge = { message: number; requestId: string; id: number | null };

export const DeliveryDoc = defineDoc<{ since: number | null; nudges: Nudge[] }>({
  kind: "pistack.delivery",
  version: 1,
  scope: "session",
  initial: () => ({ since: null, nudges: [] }),
});

export type Make = { origin: string; requestId: string; id: number | null; at: number };

export const MakeDoc = defineDoc<{ makes: Make[] }>({
  kind: "pistack.make",
  version: 1,
  scope: "session",
  initial: () => ({ makes: [] }),
});
