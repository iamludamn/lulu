import { NOTE_ID } from "../notes/store.js";
import type { ClientMessage, DeliveryReceipt } from "../protocol/wire.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isString = (value: unknown): value is string => typeof value === "string";

export function parseFrame(text: string): ClientMessage {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("Command must be an object");
  return parseClientMessage(value);
}

function parseClientMessage(value: Record<string, unknown>): ClientMessage {
  const { type, requestId, content, whenBusy, model } = value;
  if (type === "hello") return { type, incremental: value.incremental === true, schedules: value.schedules === true };
  if (type === "prompt.submit" && isString(requestId) && isString(content) && (whenBusy === "steer" || whenBusy === "followUp")) {
    const ref = value.noteRef;
    if (ref !== undefined) {
      if (!isRecord(ref) || !isString(ref.id) || !NOTE_ID.test(ref.id) || !Number.isSafeInteger(ref.revision) || Number(ref.revision) < 1) throw new Error("Invalid note reference");
      return { type, requestId, content, whenBusy, noteRef: { id: ref.id, revision: Number(ref.revision) } };
    }
    return { type, requestId, content, whenBusy };
  }
  if (type === "history.load" && isString(requestId) && Number.isSafeInteger(value.before) && Number(value.before) > 0) return { type, requestId, before: Number(value.before) };
  if (type === "prompt.receipts" && (value.source === "live" || value.source === "snapshot" || value.source === "history") &&
      Array.isArray(value.receipts) && value.receipts.length > 0 && value.receipts.length <= 32 &&
      value.receipts.every((item: unknown): item is DeliveryReceipt => isRecord(item) && isString(item.requestId) && isString(item.callId))) {
    return { type, source: value.source, receipts: value.receipts };
  }
  if (type === "prompt.abort" && isString(requestId)) return { type, requestId };
  if (type === "model.select" && isString(requestId) && isRecord(model) && isString(model.provider) && isString(model.id)) {
    return { type, requestId, model: { provider: model.provider, id: model.id } };
  }
  if ((type === "widget.keep" || type === "widget.drop") && isString(requestId) && isString(value.origin)) return { type, requestId, origin: value.origin };
  if (type === "widget.check" && isString(requestId) && isString(value.id) && Number.isInteger(value.index) && typeof value.done === "boolean") {
    return { type, requestId, id: value.id, index: value.index as number, done: value.done };
  }
  if (type === "layout.order" && isString(requestId) && Array.isArray(value.ids) && value.ids.every(isString)) {
    return { type, requestId, ids: value.ids };
  }
  if ((type === "note.generate" || type === "note.accept") && isString(requestId) && isString(value.origin)) return { type, requestId, origin: value.origin };
  if (type === "widget.make" && isString(requestId) && isString(value.origin)) return { type, requestId, origin: value.origin };
  if ((type === "asr.start" || type === "asr.finish" || type === "asr.cancel") && isString(requestId)) return { type, requestId };
  if (type === "asr.audio" && isString(requestId) && isString(value.audio)) return { type, requestId, audio: value.audio };
  if (type === "voice.start" && isString(requestId)) return { type, requestId };
  if (type === "voice.audio" && isString(requestId) && isString(value.audio)) return { type, requestId, audio: value.audio };
  if (type === "voice.mute" && isString(requestId) && typeof value.muted === "boolean") return { type, requestId, muted: value.muted };
  if (type === "voice.stop" && isString(requestId)) return { type, requestId };
  throw new Error("Unknown command");
}
