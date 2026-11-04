import type { ConversationView } from "@earendil-works/pi-durable";
import type { BusyMode, McpStatus, ModelConfig, ModelRef, SessionProgress } from "./contract.js";
import type { PanelState } from "./panel.js";
import type { AssetItem } from "./send.js";

export const MAX_CLIENT_FRAME_CHARACTERS = 64_000;

export type ClientMessage =
  | { type: "hello" }
  | { type: "prompt.submit"; requestId: string; content: string; whenBusy: BusyMode }
  | { type: "prompt.abort"; requestId: string }
  | { type: "model.select"; requestId: string; model: ModelRef }
  | { type: "widget.keep"; requestId: string; origin: string }
  | { type: "widget.drop"; requestId: string; origin: string }
  | { type: "widget.make"; requestId: string; origin: string }
  | { type: "layout.order"; requestId: string; target: "panel" | "assets"; ids: string[] }
  | { type: "voice.start"; requestId: string }
  | { type: "voice.audio"; requestId: string; audio: string }
  | { type: "voice.mute"; requestId: string; muted: boolean }
  | { type: "voice.stop"; requestId: string };

export type ViewFrame = Omit<ConversationView, "entries"> & { order: string[]; entries: ConversationView["entries"] };

export type ServerMessage =
  | { type: "state"; view: ViewFrame; progress: SessionProgress; mcp: McpStatus[]; panel: PanelState; assets: AssetItem[] }
  | { type: "models"; config: ModelConfig }
  | { type: "voice"; event: Record<string, unknown> }
  | { type: "result"; requestId: string; ok: true }
  | { type: "result"; requestId: string; ok: false; error: string };
