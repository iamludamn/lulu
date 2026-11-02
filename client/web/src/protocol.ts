import type { ServerMessage } from "@lulu/core/protocol/wire.js";

export { MAX_CLIENT_FRAME_CHARACTERS } from "@lulu/core/protocol/wire.js";
export type { ClientMessage, ServerMessage } from "@lulu/core/protocol/wire.js";
export { LIVE_DOC } from "@lulu/core/protocol/contract.js";
export { SEND_TOOL } from "@lulu/core/protocol/send.js";
export type { SendInput } from "@lulu/core/protocol/send.js";
export type { ExecutorStatus } from "@lulu/core/protocol/executor.js";
export type {
  Account,
  BotAccess,
  DefaultAccess,
  Grant,
  LiveState,
  McpStatus,
  MemoryCommit,
  ScheduleEntry,
  MemoryListing,
  MessageProgress,
  MessageState,
  ModelConfig,
  ModelRef,
  PermissionsUpdate,
  PermissionsView,
  SessionProgress,
  SubtaskProgress,
  ToolSlot,
} from "@lulu/core/protocol/contract.js";

export type ConversationView = Extract<ServerMessage, { type: "state" }>["view"];
