import type { Notice, ToolCall, ToolResult, Update } from "../line.js";

export const MODEL = "1.2.6.1";
export const INPUT_RATE = 16000;
export const OUTPUT_FORMAT = "pcm_s16le";
export const REPORT_TOOL = "report_update";
export const REPORT_INSTRUCTION = "These are job updates for the caller. Tell them in one or two spoken sentences, in your own words, what this means for them. Do not read the fields aloud, and never say a time or an id.";
const NOTICE_HEADER = "[后台通知，不是用户说的话。不要回应、不要复述，记住内容，用户问起时再用。]";
const NOTICE_CHARACTERS = { landed: 1500, overheard: 200 };

export type Down =
  | { kind: "created"; sessionId: string }
  | { kind: "updated" }
  | { kind: "closed" }
  | { kind: "callerStarted" }
  | { kind: "callerDone"; transcript: string }
  | { kind: "callerFailed" }
  | { kind: "text"; responseId: string | undefined; delta: string }
  | { kind: "textDone"; responseId: string | undefined; text: string }
  | { kind: "audioStarted"; responseId: string | undefined; ttsType: string }
  | { kind: "audio"; responseId: string | undefined; pcm: Uint8Array }
  | { kind: "audioDone"; responseId: string | undefined }
  | { kind: "calls"; calls: ToolCall[] }
  | { kind: "responseDone" }
  | { kind: "canceled" }
  | { kind: "retrieved"; items: Raw[] }
  | { kind: "error"; code: string; message: string; eventId: string }
  | { kind: "ignored" };

export type Raw = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const optional = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const record = (value: unknown): Raw => (typeof value === "object" && value !== null ? (value as Raw) : {});

export function decode(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function callsOf(event: Raw): ToolCall[] {
  const items = Array.isArray(event.items) ? (event.items as unknown[]) : [event];
  return items
    .map(record)
    .filter((item) => typeof item.call_id === "string")
    .map((item) => ({ callId: text(item.call_id), name: text(item.name), arguments: text(item.arguments) }));
}

export function parseDown(event: Raw): Down {
  const responseId = optional(event.response_id);
  switch (event.type) {
    case "session.created":
      return { kind: "created", sessionId: text(record(event.session).id) };
    case "session.updated":
      return { kind: "updated" };
    case "session.closed":
      return { kind: "closed" };
    case "conversation.item.input_audio_transcription.started":
    case "input_audio_buffer.speech_started":
      return { kind: "callerStarted" };
    case "conversation.item.input_audio_transcription.completed":
      return { kind: "callerDone", transcript: text(event.transcript) || text(event.text) };
    case "conversation.item.input_audio_transcription.failed":
      return { kind: "callerFailed" };
    case "response.output_text.delta":
      return { kind: "text", responseId, delta: text(event.delta) };
    case "response.output_text.done":
      return { kind: "textDone", responseId, text: text(event.text) };
    case "response.output_audio.started":
      return { kind: "audioStarted", responseId, ttsType: text(event.tts_type) };
    case "response.output_audio.delta":
      return { kind: "audio", responseId, pcm: decode(text(event.delta)) };
    case "response.output_audio.done":
      return { kind: "audioDone", responseId };
    case "response.function_call_arguments.done":
      return { kind: "calls", calls: callsOf(event) };
    case "response.done":
      return { kind: "responseDone" };
    case "response.canceled":
      return { kind: "canceled" };
    case "conversation.item.retrieved":
      return { kind: "retrieved", items: Array.isArray(event.items) ? (event.items as unknown[]).map(record) : [] };
    case "error": {
      const error = record(event.error);
      return { kind: "error", code: text(error.code) || text(event.code), message: text(error.message) || text(event.message), eventId: text(error.event_id) || text(event.event_id) };
    }
    default:
      return { kind: "ignored" };
  }
}

export function toolReply(calls: readonly ToolCall[], results: readonly ToolResult[]): Raw {
  return {
    type: "conversation.item.create",
    items: calls.map((call, index) => ({
      type: "message",
      role: "tool",
      call_id: call.callId,
      content: [{ type: "input_text", text: results[index]?.output ?? "" }],
    })),
  };
}

export function reportItems(callId: string, updates: readonly Update[], at: string): Raw[] {
  const output = JSON.stringify({ status: "landed", updates: updates.map((update) => update.text), at, instruction: REPORT_INSTRUCTION });
  return [
    { type: "function_call", name: REPORT_TOOL, call_id: callId, arguments: "{}" },
    { type: "message", role: "tool", call_id: callId, content: [{ type: "input_text", text: output }] },
  ];
}

export function noticeItem(notices: readonly Notice[]): Raw {
  const lines = notices.map((notice) => `work_${notice.kind}: ${notice.text.slice(0, NOTICE_CHARACTERS[notice.kind])}`);
  return { type: "message", role: "user", content: [{ type: "input_text", text: [NOTICE_HEADER, ...lines].join("\n") }] };
}

export function lastAssistant(items: readonly Raw[]): string | undefined {
  const found = items.filter((item) => item.role === "assistant" && typeof item.id === "string").at(-1);
  return found === undefined ? undefined : text(found.id);
}
