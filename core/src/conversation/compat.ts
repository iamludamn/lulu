import type { EntryRecord } from "@earendil-works/pi-durable";
import { SCHEDULE_OFFER_KIND, SCHEDULE_WIDGET_ID } from "../protocol/panel.js";
import { SEND_TOOL, type SendDetails } from "../protocol/send.js";
import type { ServerMessage } from "../protocol/wire.js";

function withoutScheduleOffer(entry: EntryRecord): EntryRecord {
  if (entry.kind === SCHEDULE_OFFER_KIND) return { id: entry.id, conversationId: entry.conversationId, kind: entry.kind };
  const message = entry.model?.[0];
  if (entry.kind !== "pi.tool-result" || message?.role !== "toolResult" || message.toolName !== SEND_TOOL) return entry;
  const details = message.details as SendDetails | undefined;
  if (details?.widget?.kind !== "panel" || details.widget.panel.body.kind !== "schedules") return entry;
  const { widget: _widget, ...rest } = details;
  return { ...entry, model: [{ ...message, details: rest }] };
}

export function withoutSchedules(message: ServerMessage): ServerMessage {
  if (message.type === "history") return { ...message, entries: message.entries.map(withoutScheduleOffer) };
  if (message.type !== "state") return message;
  const { scheduleRevision: _revision, scheduleReceipts: _receipts, ...panel } = message.panel;
  const widgets = { ...panel.widgets };
  delete widgets[SCHEDULE_WIDGET_ID];
  return {
    ...message,
    view: { ...message.view, entries: message.view.entries.map(withoutScheduleOffer) },
    panel: { ...panel, widgets, order: panel.order.filter((id) => id !== SCHEDULE_WIDGET_ID) },
  };
}
