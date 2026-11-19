import type { EntryRecord } from "@earendil-works/pi-durable";
import { ScheduleOfferEntry } from "../cron/overview.js";
import { SCHEDULE_ORIGIN_PREFIX, SCHEDULE_WIDGET_ID, type PanelState, type WidgetInput } from "../protocol/panel.js";

export function scheduleOffer(entries: readonly EntryRecord[], origin: string): WidgetInput | undefined {
  if (!origin.startsWith(SCHEDULE_ORIGIN_PREFIX)) return undefined;
  const entry = entries.find((entry) => SCHEDULE_ORIGIN_PREFIX + entry.id === origin);
  if (ScheduleOfferEntry.is(entry)) return entry.data.widget.panel;
}

export function acceptSchedule(panel: PanelState, widget: WidgetInput, origin: string, requestId: string, now: number): void {
  const previous = panel.widgets[widget.id];
  const receipt = panel.scheduleReceipts?.[origin];
  if (receipt?.requestIds.includes(requestId)) return;
  if (widget.id !== SCHEDULE_WIDGET_ID || widget.body.kind !== "schedules" || widget.body.revision !== panel.scheduleRevision) {
    throw new Error("这张预览已有新版，请使用最新卡片");
  }
  if (previous !== undefined && previous.body.kind !== "schedules") throw new Error("不能将其他组件替换为定时任务视图");
  panel.scheduleReceipts ??= {};
  const alreadyKept = previous?.origin === origin;
  panel.scheduleReceipts[origin] = {
    action: alreadyKept && receipt !== undefined ? receipt.action : previous === undefined ? "add" : "update",
    requestIds: [...(receipt?.requestIds ?? []), requestId],
  };
  if (!alreadyKept) panel.widgets[widget.id] = { ...widget, body: { ...widget.body, rows: [] }, updatedAt: now, origin };
}
