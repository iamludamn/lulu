import type { ModelRef } from "@earendil-works/pi-durable";

export type Episode = {
  id: number;
  role: "user" | "assistant";
  text: string;
};

export type EpisodeSource = {
  model: ModelRef;
  episodes: Episode[];
  through: number;
};
