import type { ClientMessage } from "../protocol/wire.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isString = (value: unknown): value is string => typeof value === "string";

export function parseFrame(text: string): ClientMessage {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("Command must be an object");
  return parseClientMessage(value);
}

function parseClientMessage(value: Record<string, unknown>): ClientMessage {
  const { type, requestId, content, whenBusy, model } = value;
  if (type === "hello") return { type };
  if (type === "prompt.submit" && isString(requestId) && isString(content) && (whenBusy === "steer" || whenBusy === "followUp")) {
    return { type, requestId, content, whenBusy };
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
  if (type === "widget.make" && isString(requestId) && isString(value.origin)) return { type, requestId, origin: value.origin };
  if ((type === "asr.start" || type === "asr.finish" || type === "asr.cancel") && isString(requestId)) return { type, requestId };
  if (type === "asr.audio" && isString(requestId) && isString(value.audio)) return { type, requestId, audio: value.audio };
  if (type === "voice.start" && isString(requestId)) return { type, requestId };
  if (type === "voice.audio" && isString(requestId) && isString(value.audio)) return { type, requestId, audio: value.audio };
  if (type === "voice.mute" && isString(requestId) && typeof value.muted === "boolean") return { type, requestId, muted: value.muted };
  if (type === "voice.stop" && isString(requestId)) return { type, requestId };
  throw new Error("Unknown command");
}
