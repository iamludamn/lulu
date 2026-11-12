import { defineDoc, type ModelRef } from "@earendil-works/pi-durable";

export type Episode = {
  id: number;
  role: "user" | "assistant";
  text: string;
};

export type EpisodeSource = {
  conversationId?: string;
  model: ModelRef;
  episodes: Episode[];
  through: number;
};

export type Recall = {
  requestId: string;
  inject: boolean;
};

export const RecallDoc = defineDoc<Recall>({
  kind: "lulu.memory.recall",
  version: 1,
  scope: "session",
  initial: () => ({ requestId: "", inject: false }),
});
