import { SCHEDULE_ORIGIN_PREFIX, SCHEDULE_WIDGET_ID, type PanelState, type WidgetInput } from "../protocol/panel.js";

export function acceptSchedule(panel: PanelState, widget: WidgetInput, origin: string, requestId: string, now: number): void {
  const previous = panel.widgets[widget.id];
  const receipt = panel.scheduleReceipts?.[origin];
  if (receipt?.requestIds.includes(requestId)) return;
  if (widget.id !== SCHEDULE_WIDGET_ID || widget.body.kind !== "schedules" ||
      (origin.startsWith(SCHEDULE_ORIGIN_PREFIX) && widget.body.revision !== panel.scheduleRevision)) {
    throw new Error("这张预览已有新版，请使用最新卡片");
  }
  if (previous !== undefined && previous.body.kind !== "schedules") throw new Error("不能将其他组件替换为定时任务视图");
  const alreadyKept = previous?.origin === origin;
  if (previous !== undefined && !alreadyKept) throw new Error("定时任务已在视图中");
  panel.scheduleReceipts ??= {};
  panel.scheduleReceipts[origin] = {
    action: alreadyKept && receipt !== undefined ? receipt.action : "add",
    requestIds: [...(receipt?.requestIds ?? []), requestId],
  };
  if (!alreadyKept) panel.widgets[widget.id] = { ...widget, body: { ...widget.body, rows: [] }, updatedAt: now, origin };
}
